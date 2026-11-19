import { execFile, spawn } from 'child_process';
import { realpath } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { FileType } from './transport/core';
import type { FileSystem } from './transport/core/fs';
import { knownHostsPaths } from './transport/core/remote-client/hostKeyStore';
import { execCommand } from './transport/core/remote-client/exec';
import { replaceHomePath } from './paths';
import { resolveRemotePath } from './debuggerHelper';
import { quoteShell } from './paths';
import { connectSsh, RunHopTarget } from './targets';
import { projectPathType, sourceIgnored } from './transfers';

type Direction = 'upload' | 'download';
const execLocal = promisify(execFile);

function rsyncError(error: NodeJS.ErrnoException): Error {
  return error.code === 'ENOENT'
    ? new Error('Install rsync on this computer or choose SFTP.')
    : error;
}

function sshCommand(target: RunHopTarget): string {
  const { config } = target;
  if (config.hop && (!Array.isArray(config.hop) || config.hop.length)) {
    throw new Error('Use SFTP for targets with RunHop SSH hops.');
  }
  // The SSH client parses the inner quotes in UserKnownHostsFile.
  const stores = knownHostsPaths()
    .map(file => '"' + file.replace(/[\\"]/g, '\\$&') + '"')
    .join(' ');
  const args = [
    'ssh',
    '-F',
    'none',
    '-p',
    String(config.port),
    '-l',
    config.username,
    '-oBatchMode=yes',
    '-oStrictHostKeyChecking=yes',
    '-oGlobalKnownHostsFile=none',
    '-oUserKnownHostsFile=' + stores,
    '-oConnectTimeout=' + Math.max(1, Math.ceil(config.connectTimeout / 1000)),
  ];
  if (config.privateKeyPath) {
    args.push('-i', config.privateKeyPath);
  }
  if (config.agent) {
    args.push('-oIdentityAgent=' + replaceHomePath(config.agent));
  }
  // rsync's -e parser uses doubled quotes for a literal quote within a quoted argument.
  return args.map(arg => "'" + arg.replace(/'/g, "''") + "'").join(' ');
}

async function listFiles(
  target: RunHopTarget,
  fs: FileSystem,
  root: string,
  selected: string,
  outputs: string[],
  cancellation: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string }>
): Promise<string[]> {
  const kind = await projectPathType(fs, root, selected);
  const scope = path.join(target.service.baseDir, ...selected.split('/'));
  if (
    sourceIgnored(target, scope, outputs) ||
    (kind === FileType.Directory && target.ignoreDirectory(scope))
  ) {
    throw new Error('The selected path is excluded by the project ignore rules.');
  }
  const files: string[] = [];
  let lastReport = 0;
  async function walk(
    relative: string,
    info: Awaited<ReturnType<FileSystem['lstat']>>
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (info.type !== FileType.File && info.type !== FileType.Directory) {
      return;
    }
    const local = path.join(target.service.baseDir, ...relative.split('/'));
    if (
      sourceIgnored(target, local, outputs) ||
      (info.type === FileType.Directory && target.ignoreDirectory(local))
    ) {
      return;
    }
    if (
      target.config.maxFileSize &&
      info.type === FileType.File &&
      info.size > target.config.maxFileSize * 1024 * 1024
    ) {
      throw new Error('A project file exceeds maxFileSize: ' + relative);
    }
    if (relative) {
      files.push(relative);
    }
    if (info.type === FileType.Directory) {
      if (Date.now() - lastReport > 500) {
        lastReport = Date.now();
        progress.report({
          message: 'Scanning · ' + (relative || '.') + ' · ' + files.length + ' paths',
        });
      }
      for (const entry of await fs.list(fs.pathResolver.join(root, relative))) {
        // Exclude special files and links before traversing any children.
        if (
          (entry.type === FileType.File || entry.type === FileType.Directory) &&
          entry.name &&
          entry.name !== '.' &&
          entry.name !== '..' &&
          !/[\\/:\0]/.test(entry.name)
        ) {
          await walk(path.posix.join(relative, entry.name), entry);
        }
      }
    }
  }
  await walk(selected, await fs.lstat(fs.pathResolver.join(root, selected)));
  return files;
}

function runRsync(
  args: string[],
  cwd: string,
  files: string[],
  cancellation: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string }>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn('rsync', args, { cwd, detached: grouped, windowsHide: true });
    let errorOutput = '';
    let lastReport = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          reject(error);
        }
      }
    };
    const cancel = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const subscription = cancellation.onCancellationRequested(cancel);
    if (cancellation.isCancellationRequested) {
      cancel();
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (Date.now() - lastReport > 500) {
        const line = chunk
          .split(/[\r\n]+/)
          .map(item => item.trim())
          .filter(Boolean)
          .at(-1);
        if (line) {
          progress.report({ message: line });
          lastReport = Date.now();
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      errorOutput = (errorOutput + chunk).slice(-4096);
    });
    // A failed spawn or remote process can close stdin before the list is written.
    child.stdin.on('error', () => {});
    child.stdin.end(files.length ? files.join('\0') + '\0' : '');
    child.once('error', error => reject(rsyncError(error)));
    child.once('close', code => {
      subscription.dispose();
      clearTimeout(killTimer);
      if (cancellation.isCancellationRequested) {
        reject(new vscode.CancellationError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            'rsync exited with code ' +
              code +
              '. Verify that rsync and OpenSSH can use this target. ' +
              errorOutput.trim()
          )
        );
      }
    });
  });
}

export async function transferWithRsync(
  target: RunHopTarget,
  scope: string,
  direction: Direction,
  destination: string,
  outputs: string[]
): Promise<void> {
  const { config, service } = target;
  const host = config.host;
  if (!/^[A-Za-z0-9._:][A-Za-z0-9._:%-]*$/.test(host)) {
    throw new Error('The selected SSH host cannot be used by rsync.');
  }
  const endpoint = (host.includes(':') ? '[' + host + ']' : host) + ':';
  const ssh = sshCommand(target);
  const selected = path.relative(service.baseDir, scope).split(path.sep).join('/');
  const uploading = direction === 'upload';
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'RunHop · rsync · ' + host,
      cancellable: true,
    },
    async (progress, cancellation) => {
      const local = await execLocal('rsync', ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).catch(error => {
        throw rsyncError(error);
      });
      progress.report({ message: 'Connecting to the remote project' });
      const { fs: remote, client } = await connectSsh(service, config);
      const check = await execCommand(client.getRawClient(), 'rsync --version', {
        timeout: 8000,
        closeStdin: true,
      });
      if (check.code !== 0) {
        throw new Error(
          'rsync must be available in the remote shell. Choose SFTP if it is unavailable.'
        );
      }
      if (cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (uploading) {
        await remote.ensureDir(config.remotePath);
      }
      const root = await resolveRemotePath(client, config.remotePath);
      const fs = uploading ? service.getLocalFileSystem() : remote;
      const source = uploading ? await realpath(service.baseDir) : root;
      const files = await listFiles(target, fs, source, selected, outputs, cancellation, progress);
      if (!files.length) {
        return;
      }
      progress.report({
        message: (uploading ? 'Uploading' : 'Downloading') + ' · ' + files.length + ' paths',
      });
      // Apple’s openrsync tokenizes --rsync-path, whereas GNU rsync passes
      // that option through as shell text. Openrsync accepts an escaped
      // destination path directly.
      const apple = /openrsync/i.test(local.stdout);
      const remotePath = apple
        ? endpoint + quoteShell(root.replace(/\/$/, '') + '/')
        : endpoint + './';
      await runRsync(
        [
          '-0',
          '-t',
          '-d',
          '-R',
          '--files-from=-',
          '--progress',
          ...(apple ? [] : ['--rsync-path=cd ' + quoteShell(root) + ' && exec rsync']),
          '-e',
          ssh,
          '--',
          ...(uploading ? ['./', remotePath] : [remotePath, './']),
        ],
        uploading ? source : destination,
        files,
        cancellation,
        progress
      );
    }
  );
}
