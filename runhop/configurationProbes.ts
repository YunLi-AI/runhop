import * as path from 'node:path';
import { resolveRemotePath } from './debuggerHelper';
import { quoteShell } from './paths';
import { Connection, Interpreter, isRecord, isRemotePython, Settings } from './settings';
import { resolveProjectTarget, resolveTarget } from './targets';
import { withRemoteProbe } from './transport/core/remoteFs';
import { execCommand, ExecResult } from './transport/core/remote-client/exec';

const inspectPython = [
  'import json, os, sys',
  'prefix = sys.prefix',
  'conda = os.path.isdir(os.path.join(prefix, "conda-meta"))',
  'kind = "Conda" if conda else "Virtual environment" if sys.prefix != getattr(sys, "base_prefix", sys.prefix) or hasattr(sys, "real_prefix") else "System / standalone"',
  'conda_name = ("base" if os.path.isdir(os.path.join(prefix, "condabin")) else os.path.basename(prefix)) if conda else ""',
  'print(json.dumps(dict(version=sys.version.split()[0], executable=sys.executable, kind=kind, prefix=prefix, condaName=conda_name)))',
].join('\n');

const discoverPython = [
  'show_python() { [ -f "$1" ] && [ -x "$1" ] && printf "%s\\n" "$1"; }',
  'for name in python3 python; do',
  '  executable=$(command -v "$name") && show_python "$executable"',
  'done',
  'if [ -n "$1" ]; then',
  '  show_python "$1/.venv/bin/python"',
  '  show_python "$1/venv/bin/python"',
  'fi',
  'if [ -r "$HOME/.conda/environments.txt" ]; then',
  '  while IFS= read -r prefix || [ -n "$prefix" ]; do',
  '    case "$prefix" in /*) show_python "$prefix/bin/python" ;; esac',
  '  done < "$HOME/.conda/environments.txt"',
  'fi',
  'for prefix in "$2" "$HOME/.conda" "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/mambaforge"; do',
  '  [ -n "$prefix" ] || continue',
  '  show_python "$prefix/bin/python"',
  '  for executable in "$prefix"/envs/*/bin/python; do show_python "$executable"; done',
  'done',
  'exit 0',
].join('\n');

function output(result: ExecResult): string {
  if (result.timedOut) throw new Error('The remote interpreter check timed out.');
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().slice(0, 600) || 'The remote command failed.');
  }
  return result.stdout;
}

export async function testConfigurationServer(
  workspace: string,
  raw: Connection,
  profile?: string
) {
  const baseDir = path.resolve(workspace, typeof raw.context === 'string' ? raw.context : '.');
  const { config } = resolveProjectTarget(workspace, { raw, baseDir }, profile);
  return withRemoteProbe(config, async fs => {
    const client = fs.getClient();
    const home = await resolveRemotePath(client, '.');
    const root = await resolveRemotePath(client, config.remotePath).catch(() => undefined);
    return { host: config.host, port: config.port, home, root };
  });
}

export async function checkConfigurationPython(
  settings: Settings,
  workspace: string,
  anchor: string,
  interpreter: Interpreter,
  discover: boolean
) {
  const { config } = resolveTarget(
    settings.targets,
    workspace,
    anchor,
    interpreter.target,
    interpreter.profile
  );
  return withRemoteProbe(config, async fs => {
    const client = fs.getClient().getRawClient();
    if (discover) {
      const mappedRoot = await resolveRemotePath(fs.getClient(), config.remotePath).catch(() => '');
      const condaRoot = interpreter.condaExecutable
        ? path.posix.dirname(path.posix.dirname(interpreter.condaExecutable))
        : '';
      const command =
        'exec /bin/sh -c ' +
        [discoverPython, 'runhop-python-discovery', mappedRoot, condaRoot]
          .map(quoteShell)
          .join(' ');
      const result = await execCommand(client, command, {
        timeout: 15_000,
        closeStdin: true,
      });
      return {
        candidates: [
          ...new Set(
            output(result)
              .split(/\r?\n/)
              .filter(item => path.posix.isAbsolute(item) && isRemotePython(item))
          ),
        ].slice(0, 150),
      };
    }
    const command =
      'exec ' + [interpreter.path, '-I', '-c', inspectPython].map(quoteShell).join(' ');
    const result = await execCommand(client, command, { timeout: 15_000, closeStdin: true });
    let info: unknown;
    try {
      info = JSON.parse(output(result).trim().split('\n').at(-1) ?? '');
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('The remote Python returned invalid version information.');
      }
      throw error;
    }
    const fields = ['version', 'executable', 'kind', 'prefix', 'condaName'] as const;
    if (!isRecord(info) || fields.some(key => typeof info[key] !== 'string')) {
      throw new Error('The remote Python returned incomplete version information.');
    }
    return {
      info: Object.fromEntries(fields.map(key => [key, (info[key] as string).slice(0, 2048)])),
    };
  });
}
