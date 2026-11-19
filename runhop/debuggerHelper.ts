import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import * as path from 'path';
import { FileType, isNotFoundError, RemoteFileSystem } from './transport/core';
import { execCommand } from './transport/core/remote-client/exec';
import type SSHClient from './transport/core/remote-client/sshClient';
import { quoteShell } from './paths';

declare const RUNHOP_DEBUGPY_SHA256: string;

// A ready directory is published atomically, including when several VS Code
// windows deploy to the same account at once.
const deploy = [
  'import hashlib, os, shutil, sys, tempfile, zipfile',
  'if sys.version_info < (3, 8):',
  '    raise SystemExit("RunHop Debug requires Python 3.8 or later.")',
  'wheel, target, digest = sys.argv[1:]',
  'with open(wheel, "rb") as payload:',
  '    if hashlib.sha256(payload.read()).hexdigest() != digest:',
  '        raise SystemExit("The RunHop debugger bundle failed checksum verification.")',
  'stage = tempfile.mkdtemp(prefix=".unpack-", dir=os.path.dirname(target))',
  'try:',
  '    with zipfile.ZipFile(wheel) as archive:',
  '        archive.extractall(stage)',
  '    if not os.path.isfile(os.path.join(stage, "debugpy", "adapter", "__main__.py")):',
  '        raise SystemExit("The RunHop debugger bundle is incomplete.")',
  '    with open(os.path.join(stage, ".ready"), "w") as marker:',
  '        marker.write(digest)',
  '    try:',
  '        os.rename(stage, target)',
  '    except OSError:',
  '        if not os.path.isfile(os.path.join(target, ".ready")):',
  '            raise',
  'finally:',
  '    shutil.rmtree(stage, ignore_errors=True)',
].join('\n');

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

async function ready(fs: RemoteFileSystem, target: string): Promise<boolean> {
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

const deployments = new WeakMap<SSHClient, Promise<string>>();

export async function prepareDebugger(
  fs: RemoteFileSystem,
  client: SSHClient,
  python: string,
  bundle: string,
  onDeploy: () => void
): Promise<string> {
  const previous = deployments.get(client);
  const deployment = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() =>
    deployDebugger(fs, client, python, bundle, onDeploy)
  );
  deployments.set(client, deployment);
  try {
    return await deployment;
  } finally {
    if (deployments.get(client) === deployment) {
      deployments.delete(client);
    }
  }
}

async function deployDebugger(
  fs: RemoteFileSystem,
  client: SSHClient,
  python: string,
  bundle: string,
  onDeploy: () => void
): Promise<string> {
  const home = await resolveRemotePath(client, '.');
  const cache = path.posix.join(home, '.cache', 'runhop', 'debugpy');
  const target = path.posix.join(cache, RUNHOP_DEBUGPY_SHA256);
  if (await ready(fs, target)) {
    return target;
  }
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
    if (result.timedOut || result.code !== 0 || !(await ready(fs, target))) {
      throw new Error(
        'RunHop could not prepare its debugger in ' +
          cache +
          '. ' +
          (result.timedOut ? 'The remote preparation timed out.' : result.stderr.trim())
      );
    }
    return target;
  } finally {
    await fs.unlink(upload).catch(() => {});
  }
}
