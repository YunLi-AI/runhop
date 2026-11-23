"""Inspect a Python environment or commit one RunHop dependency edit."""

import ast
import hashlib
import importlib.util
import json
import os
import signal
import stat
import sys
import tokenize
from functools import lru_cache
from importlib.machinery import PathFinder


MAX_SOURCE = 8 * 1024 * 1024
MAX_CACHED_SOURCE = 512 * 1024
RESOLVER_IDLE_TIMEOUT = 90


def find_spec(module):
    parts = module.split(".")
    if not module or not all(part.isidentifier() for part in parts):
        return None
    search = None
    for index in range(1, len(parts) + 1):
        spec = PathFinder.find_spec(".".join(parts[:index]), search)
        if spec is None:
            return None
        search = spec.submodule_search_locations
        if search is None and index < len(parts):
            return None
    return spec


def source_file(spec):
    if not spec.origin or not spec.origin.endswith((".py", ".pyw")):
        return None
    file = os.path.realpath(spec.origin)
    try:
        info = os.stat(file)
    except (FileNotFoundError, NotADirectoryError):
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE:
        return None
    return file, info


def parse_source(file):
    with tokenize.open(file) as stream:
        return ast.parse(stream.read(MAX_SOURCE + 1), filename=file).body


@lru_cache(maxsize=16)
def cached_source(file, revision):
    return parse_source(file)


def named_statement(body, name):
    for node in reversed(body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == name:
                return node, None
        elif isinstance(node, (ast.ImportFrom, ast.Import)):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".", 1)[0]
                if bound == name:
                    return node, alias
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(target, ast.Name) and target.id == name for target in targets):
                return node, None
    return None, None


def location(module, members, visited):
    key = (module, tuple(members))
    if key in visited or len(visited) >= 24:
        return None
    visited.add(key)
    spec = find_spec(module)
    if spec is None:
        return None
    package = spec.submodule_search_locations is not None
    source = source_file(spec)
    file, info = source if source else (None, None)
    result = dict(path=file, line=1, module=module, package=package, exact=not members) if file else None
    if not members:
        return result

    name, *tail = members
    if file:
        try:
            body = (
                cached_source(file, fingerprint(info))
                if info.st_size <= MAX_CACHED_SOURCE
                else parse_source(file)
            )
        except (OSError, SyntaxError, UnicodeError):
            body = []
        node, alias = named_statement(body, name)
        if isinstance(node, ast.ImportFrom):
            imported = "." * node.level + (node.module or "")
            if node.level:
                base = module if package else module.rpartition(".")[0]
                try:
                    imported = importlib.util.resolve_name(imported, base) if base else ""
                except ImportError:
                    imported = ""
            linked = location(imported, [alias.name] + tail, visited) if imported else None
            if linked and linked["exact"]:
                return linked
        elif isinstance(node, ast.Import):
            imported = alias.name if alias.asname else name
            linked = location(imported, tail, visited)
            if linked and linked["exact"]:
                return linked
        elif node:
            current = node
            for member in tail:
                if not isinstance(current, ast.ClassDef):
                    current = None
                    break
                current, _ = named_statement(current.body, member)
            result.update(line=(current or node).lineno, exact=current is not None)
            return result

    linked = location(module + "." + name, tail, visited) if package else None
    return linked or result


def locate(query):
    module = query["module"]
    members = query["members"]
    if not all(isinstance(name, str) and name.isidentifier() for name in members):
        return None
    if module.startswith("."):
        parent = query.get("package")
        if not parent:
            return None
        try:
            module = importlib.util.resolve_name(module, parent)
        except ImportError:
            return None
    return location(module, members, set())


def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def replace(query):
    target = query["path"]
    temporary = query["temporary"]
    if os.path.realpath(target) != target:
        return dict(status="conflict", message="The remote source path changed. Reopen the definition.")
    with open(target, "rb") as stream:
        original = os.fstat(stream.fileno())
        if not stat.S_ISREG(original.st_mode) or original.st_size > MAX_SOURCE:
            return dict(status="conflict", message="The remote source is no longer an editable file.")
        current = hashlib.sha256(stream.read(MAX_SOURCE + 1)).hexdigest()
    if current == query["newDigest"]:
        return dict(status="saved")
    if current != query["originalDigest"]:
        return dict(status="conflict", message="The remote source changed since it was opened. Reload it before saving.")
    if not os.access(target, os.W_OK):
        return dict(status="permission", message="The SSH account cannot write this dependency.")
    with open(temporary, "rb") as stream:
        if hashlib.sha256(stream.read(MAX_SOURCE + 1)).hexdigest() != query["newDigest"]:
            return dict(status="conflict", message="The staged file changed during upload.")
    staged = os.stat(temporary, follow_symlinks=False)
    if (staged.st_uid, staged.st_gid) != (original.st_uid, original.st_gid):
        os.chown(temporary, original.st_uid, original.st_gid)
    os.chmod(temporary, stat.S_IMODE(original.st_mode) & 0o777)
    if fingerprint(os.stat(target, follow_symlinks=False)) != fingerprint(original):
        return dict(status="conflict", message="The remote source changed while saving. Reload it before saving.")
    os.replace(temporary, target)
    return dict(status="saved")


def execute(command, query):
    try:
        if command == "locate":
            return locate(query)
        if command == "replace":
            return replace(query)
        raise ValueError("Unknown RunHop source operation.")
    except PermissionError as error:
        return dict(status="permission", message=str(error))


def serve():
    while True:
        # Also expire remotely if the client disappears without sending EOF.
        signal.alarm(RESOLVER_IDLE_TIMEOUT)
        line = sys.stdin.buffer.readline()
        signal.alarm(0)
        if not line:
            return
        request = json.loads(line)
        PathFinder.invalidate_caches()
        try:
            result = execute("locate", request["query"])
        except Exception as error:
            result = dict(status="error", message=str(error))
        response = dict(id=request["id"], result=result)
        print("runhop-source " + json.dumps(response), flush=True)


if sys.argv[1] == "serve":
    serve()
else:
    print(json.dumps(execute(sys.argv[1], json.load(sys.stdin))))
