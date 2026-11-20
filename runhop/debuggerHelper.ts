import { execFile } from 'node:child_process';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'path';
import { promisify } from 'node:util';
import type { ClientChannel } from 'ssh2';
import { FileType, isNotFoundError, RemoteFileSystem } from './transport/core';
import { execCommand } from './transport/core/remote-client/exec';
import type SSHClient from './transport/core/remote-client/sshClient';
import { quoteShell } from './paths';
import { openChannel, startupTimeout } from './sshChannel';

declare const RUNHOP_DEBUGPY_SHA256: string;

const cacheReady = [
  'def ready(directory):',
  '    try:',
  '        with open(os.path.join(directory, ".ready")) as marker:',
  '            return marker.read(len(digest) + 1) == digest and os.path.isfile(os.path.join(directory, "debugpy", "adapter", "__main__.py"))',
  '    except (FileNotFoundError, NotADirectoryError, IsADirectoryError, UnicodeError):',
  '        return False',
].join('\n');

// A ready directory is published atomically, including when several VS Code
// windows deploy to the same account at once.
const deploy = [
  'import hashlib, os, shutil, sys, tempfile, zipfile',
  'if sys.version_info < (3, 8):',
  '    raise SystemExit("RunHop Debug requires Python 3.8 or later.")',
  'wheel, target, digest = sys.argv[1:]',
  cacheReady,
  'with open(target + ".lock", "a+b") as lock:',
  '    if os.name == "nt":',
  '        import msvcrt',
  '        lock.seek(0)',
  '        msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)',
  '    else:',
  '        import fcntl',
  '        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)',
  '    if ready(target):',
  '        sys.exit(0)',
  '    with open(wheel, "rb") as payload:',
  '        if hashlib.sha256(payload.read()).hexdigest() != digest:',
  '            raise SystemExit("The RunHop debugger bundle failed checksum verification.")',
  '    with tempfile.TemporaryDirectory(prefix=".unpack-", dir=os.path.dirname(target)) as staging:',
  '        stage = os.path.join(staging, "debugpy")',
  '        with zipfile.ZipFile(wheel) as archive:',
  '            archive.extractall(stage)',
  '        with open(os.path.join(stage, ".ready"), "w") as marker:',
  '            marker.write(digest)',
  '        if not ready(stage):',
  '            raise SystemExit("The RunHop debugger bundle is incomplete.")',
  '        if os.path.lexists(target):',
  '            os.rename(target, os.path.join(staging, "previous"))',
  '        os.rename(stage, target)',
].join('\n');

const remoteBootstrap = [
  'import json, os, runpy, sys',
  'if sys.version_info < (3, 8):',
  '    raise SystemExit("RunHop Debug requires Python 3.8 or later.")',
  'digest = sys.argv.pop(1)',
  'home = os.path.expanduser("~")',
  'if not os.path.isabs(home):',
  '    raise SystemExit("RunHop could not find the remote home directory.")',
  'target = os.path.join(os.path.realpath(home), ".cache", "runhop", "debugpy", digest)',
  cacheReady,
  'if not ready(target):',
  '    print("RUNHOP_DEBUGPY " + json.dumps(target), flush=True)',
  '    sys.exit(0)',
  'print("RUNHOP_DEBUGPY null", flush=True)',
  'sys.path.insert(0, target)',
  'runpy.run_module("debugpy.adapter", run_name="__main__", alter_sys=True)',
].join('\n');

export async function prepareLocalDebugger(
  storage: string,
  python: string,
  cwd: string,
  bundle: string,
  onDeploy: () => void
): Promise<string> {
  const cache = path.join(storage, 'debugpy');
  const target = path.join(cache, RUNHOP_DEBUGPY_SHA256);
  const ready = async () => {
    try {
      return (
        (await readFile(path.join(target, '.ready'), 'utf8')) === RUNHOP_DEBUGPY_SHA256 &&
        (await stat(path.join(target, 'debugpy', 'adapter', '__main__.py'))).isFile()
      );
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
      throw error;
    }
  };
  if (await ready()) return target;
  onDeploy();
  await mkdir(cache, { recursive: true });
  await promisify(execFile)(
    python,
    ['-I', '-S', '-c', deploy, bundle, target, RUNHOP_DEBUGPY_SHA256],
    { cwd, timeout: 60_000, windowsHide: true }
  ).catch(error => {
    const detail = error.stderr?.trim() || 'Could not unpack the bundled debugger.';
    throw new Error('RunHop could not prepare its local debugger. ' + detail);
  });
  if (!(await ready())) {
    throw new Error('The local RunHop debugger cache is incomplete at ' + target);
  }
  return target;
}

export function resolveRemotePath(client: SSHClient, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getFsClient().realpath(value, (error, result) => {
      if (error) {
        reject(error);
      } else if (!path.posix.isAbsolute(result)) {
        reject(new Error('The server returned an invalid absolute path.'));
      } else {
        resolve(result);
      }
    });
  });
}

async function deployed(fs: RemoteFileSystem, target: string): Promise<boolean> {
  try {
    const marker = await fs.readFile(path.posix.join(target, '.ready'));
    const adapter = await fs.lstat(path.posix.join(target, 'debugpy', 'adapter', '__main__.py'));
    return marker.toString() === RUNHOP_DEBUGPY_SHA256 && adapter.type === FileType.File;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

const deployments = new WeakMap<SSHClient, Map<string, Promise<void>>>();

// The bootstrap writes exactly one line before handing the same stdio stream
// to debugpy. Leave any following bytes for the DAP reader.
function readBootstrap(channel: ClientChannel): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      channel.off('readable', readable);
      channel.off('close', close);
      channel.off('error', fail);
    };
    const fail = (error: Error) => {
      cleanup();
      channel.on('error', () => {});
      channel.close();
      reject(error);
    };
    const close = () => {
      const detail = channel.stderr.read()?.toString('utf8').trim();
      fail(new Error('Remote debugpy could not start.' + (detail ? ' ' + detail : '')));
    };
    const readable = () => {
      const chunk: Buffer | null = channel.read();
      if (!chunk) return;
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline < 0 && pending.length <= 8192) return;
      const header = pending.subarray(0, newline).toString('utf8');
      if (newline < 0 || newline > 8192 || !header.startsWith('RUNHOP_DEBUGPY ')) {
        fail(new Error('Unexpected remote debugger startup output. Check the SSH shell startup.'));
        return;
      }
      try {
        const target: unknown = JSON.parse(header.slice('RUNHOP_DEBUGPY '.length));
        if (
          target !== null &&
          (typeof target !== 'string' ||
            target.includes('\0') ||
            !path.posix.isAbsolute(target) ||
            path.posix.normalize(target) !== target ||
            !target.endsWith('/.cache/runhop/debugpy/' + RUNHOP_DEBUGPY_SHA256))
        ) {
          throw new Error('The remote debugger returned an invalid cache path.');
        }
        cleanup();
        if (target === null) {
          const rest = pending.subarray(newline + 1);
          if (rest.length) channel.unshift(rest);
        } else {
          channel.end();
          channel.close();
        }
        resolve(target);
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(
      () => fail(new Error('Timed out starting remote debugpy.')),
      startupTimeout
    );
    channel.on('error', fail);
    channel.once('close', close);
    channel.on('readable', readable);
  });
}

export async function startRemoteDebugger(
  fs: RemoteFileSystem,
  client: SSHClient,
  python: string,
  bundle: string,
  onDeploy: () => void,
  checkCancelled: () => void
): Promise<ClientChannel> {
  const command =
    'exec ' +
    [python, '-I', '-u', '-c', remoteBootstrap, RUNHOP_DEBUGPY_SHA256].map(quoteShell).join(' ');
  checkCancelled();
  const channel = await openChannel(client.getRawClient(), command);
  const missing = await readBootstrap(channel);
  if (missing === null) return channel;

  checkCancelled();
  await deployMissingDebugger(fs, client, python, bundle, missing, onDeploy);
  checkCancelled();
  const retry = await openChannel(client.getRawClient(), command);
  if ((await readBootstrap(retry)) !== null) {
    throw new Error('The remote RunHop debugger cache is incomplete after deployment.');
  }
  return retry;
}

async function deployMissingDebugger(
  fs: RemoteFileSystem,
  client: SSHClient,
  python: string,
  bundle: string,
  target: string,
  onDeploy: () => void
): Promise<void> {
  let pending = deployments.get(client);
  if (!pending) {
    pending = new Map();
    deployments.set(client, pending);
  }
  const previous = pending.get(target);
  if (previous) return previous;
  const deployment = deployDebugger(fs, client, python, bundle, target, onDeploy);
  pending.set(target, deployment);
  try {
    await deployment;
  } finally {
    pending.delete(target);
  }
}

async function deployDebugger(
  fs: RemoteFileSystem,
  client: SSHClient,
  python: string,
  bundle: string,
  target: string,
  onDeploy: () => void
): Promise<void> {
  // A different session/window may have completed deployment since this
  // launch reported a miss.
  if (await deployed(fs, target)) return;
  const cache = path.posix.dirname(target);
  await fs.ensureDir(cache);
  const upload = path.posix.join(cache, '.upload-' + randomUUID() + '.whl');
  onDeploy();
  try {
    await fs.put(createReadStream(bundle), upload, { flags: 'wx', mode: 0o600 });
    const command = [python, '-I', '-S', '-c', deploy, upload, target, RUNHOP_DEBUGPY_SHA256]
      .map(quoteShell)
      .join(' ');
    const result = await execCommand(client.getRawClient(), 'exec ' + command, {
      timeout: 60_000,
      closeStdin: true,
    });
    if (result.timedOut || result.code !== 0) {
      throw new Error(
        'RunHop could not prepare its debugger in ' +
          cache +
          '. ' +
          (result.timedOut ? 'The remote preparation timed out.' : result.stderr.trim())
      );
    }
  } finally {
    await fs.unlink(upload).catch(() => {});
  }
}
