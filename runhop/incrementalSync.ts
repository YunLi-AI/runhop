import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import { resolveRemotePath } from './debuggerHelper';
import { isLocalPathAtOrUnder, quoteShell } from './paths';
import { connectSsh, type RunHopTarget } from './targets';
import { isNotFoundError } from './transport/core';
import type FileSystem from './transport/core/fs/fileSystem';
import { execCommand } from './transport/core/remote-client/exec';
import {
  type ProjectTransfer,
  projectTransferKey,
  requireSavedProjectFiles,
  sourceIgnored,
  uploadSourceFiles,
} from './transfers';
import type { SyncPolicy } from './settings';

type Baseline = Record<string, { local: string; remote: string; sha256: string }>;
type Source = { fingerprint: string; size: number };
type RemoteSource = { fingerprint: string; sha256?: string };
type Inspection = [file: string, size: number, previous: string | null, previousSize?: number];

export type SyncConflictKind =
  | 'local_modified'
  | 'remote_modified'
  | 'both_modified'
  | 'local_deleted'
  | 'remote_deleted'
  | 'untracked_remote';

export interface SyncConflict {
  file: string;
  kind: SyncConflictKind;
  localFingerprint: string | null;
  remoteFingerprint: string | null;
  baselineLocalFingerprint: string | null;
  baselineRemoteFingerprint: string | null;
  localSha256: string | null;
  remoteSha256: string | null;
  baselineSha256: string | null;
}

export interface SyncOptions {
  policy?: SyncPolicy;
  overwriteSavedFiles?: boolean;
  resolveConflict?: (
    conflict: SyncConflict
  ) => Promise<'local' | 'remote' | 'baseline' | 'skip'>;
  scope?: string;
  refreshOnly?: boolean;
  deleteRemoteOnUpload?: boolean;
}

const inspectScript = [
  'import hashlib, json, os, stat, sys',
  'root = sys.argv[1]',
  'result = []',
  'verified_dirs = set()',
  'for relative, local_size, previous, *known_size in json.load(sys.stdin):',
  '    file = os.path.join(root, relative)',
  '    directory = os.path.dirname(file)',
  '    if directory not in verified_dirs:',
  '        if os.path.realpath(directory) != directory:',
  '            raise ValueError("Symbolic link in remote source path: " + relative)',
  '        verified_dirs.add(directory)',
  '    try:',
  '        info = os.lstat(file)',
  '    except FileNotFoundError:',
  '        result.append(None)',
  '        continue',
  '    if not stat.S_ISREG(info.st_mode):',
  '        raise ValueError("Remote source path is not a regular file: " + relative)',
  '    fingerprint = ":".join(map(str, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)))',
  '    entry = {"fingerprint": fingerprint}',
  '    if fingerprint != previous and (local_size == info.st_size or info.st_size in known_size):',
  '        digest = hashlib.sha256()',
  '        with open(file, "rb") as stream:',
  '            for chunk in iter(lambda: stream.read(1048576), b""):',
  '                digest.update(chunk)',
  '        after = os.lstat(file)',
  '        if (after.st_ino, after.st_mtime_ns, after.st_ctime_ns, after.st_size) != (info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size):',
  '            raise ValueError("Remote source changed during verification: " + relative)',
  '        entry["sha256"] = digest.hexdigest()',
  '    result.append(entry)',
  'json.dump(result, sys.stdout)',
].join('\n');

const publishScript = [
  'import hashlib, json, os, stat, sys',
  'root = sys.argv[1]',
  'relative, staging, expected, digest = json.load(sys.stdin)',
  'file = os.path.join(root, relative)',
  'directory = os.path.dirname(file)',
  'if os.path.dirname(staging) != directory or os.path.realpath(directory) != directory:',
  '    raise ValueError("Unsafe remote source path: " + relative)',
  'def fingerprint(info):',
  '    return ":".join(map(str, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)))',
  'if digest is None:',
  '    staged = os.lstat(staging)',
  '    if not stat.S_ISREG(staged.st_mode):',
  '        raise ValueError("Staged source is not a regular file: " + relative)',
  '    os.replace(staging, file)',
  '    receipt = None',
  '    try:',
  '        info = os.lstat(file)',
  '        if (info.st_dev, info.st_ino) == (staged.st_dev, staged.st_ino):',
  '            receipt = fingerprint(info)',
  '    except OSError:',
  '        pass',
  '    json.dump(receipt, sys.stdout)',
  '    sys.exit(0)',
  'with open(staging, "rb") as stream:',
  '    staged = os.fstat(stream.fileno())',
  '    if not stat.S_ISREG(staged.st_mode):',
  '        raise ValueError("Staged source is not a regular file: " + relative)',
  '    data = hashlib.sha256()',
  '    for chunk in iter(lambda: stream.read(1048576), b""):',
  '        data.update(chunk)',
  'if data.hexdigest() != digest or fingerprint(os.lstat(staging)) != fingerprint(staged):',
  '    raise ValueError("Source changed while uploading: " + relative)',
  'try:',
  '    actual = fingerprint(os.lstat(file))',
  'except FileNotFoundError:',
  '    actual = None',
  'if actual != expected:',
  '    raise ValueError("Remote source changed during upload: " + relative)',
  'if actual is None:',
  '    os.link(staging, file)',
  '    os.unlink(staging)',
  'else:',
  '    os.replace(staging, file)',
  'json.dump(fingerprint(os.lstat(file)), sys.stdout)',
].join('\n');

function isDirty(file: string): boolean {
  return vscode.workspace.textDocuments.some(
    doc => doc.isDirty && doc.uri.scheme === 'file' && doc.uri.fsPath === file
  );
}

async function waitForDocumentClean(
  file: string,
  cancellation: vscode.CancellationToken,
  timeout = 1_500
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (isDirty(file) && Date.now() < deadline) {
    checkCancelled(cancellation);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  return !isDirty(file);
}

function checkCancelled(cancellation: vscode.CancellationToken): void {
  if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
}

async function localSource(file: string): Promise<Source | undefined> {
  try {
    const info = await lstat(file, { bigint: true });
    if (info.isFile()) {
      return {
        fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
        size: Number(info.size),
      };
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export async function waitForStableSource(
  file: string,
  cancellation: vscode.CancellationToken,
  timeout = 1_500
): Promise<Source | undefined> {
  const deadline = Date.now() + timeout;
  let previous: Source | undefined;
  let stableReads = 0;
  while (Date.now() < deadline) {
    checkCancelled(cancellation);
    const current = await localSource(file);
    if (!current) return undefined;
    if (previous?.fingerprint === current.fingerprint) {
      stableReads++;
      if (stableReads >= 2) return current;
    } else {
      previous = current;
      stableReads = 1;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  return previous;
}

async function localSnapshot(
  project: RunHopTarget,
  outputs: string[],
  cancellation: vscode.CancellationToken,
  scope = project.service.baseDir
): Promise<Map<string, Source>> {
  const root = project.service.baseDir;
  const files = new Map<string, Source>();
  const directories = [scope];
  while (directories.length) {
    checkCancelled(cancellation);
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (directory !== root && isNotFoundError(error)) return [];
      throw error;
    });
    const paths: string[] = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (sourceIgnored(project, file, outputs)) continue;
      if (entry.isDirectory() && !project.ignoreDirectory(file)) directories.push(file);
      if (entry.isFile()) paths.push(file);
    }
    for (let offset = 0; offset < paths.length; offset += 32) {
      checkCancelled(cancellation);
      await Promise.all(
        paths.slice(offset, offset + 32).map(async file => {
          const source = await waitForStableSource(file, cancellation);
          if (source) files.set(path.relative(root, file).split(path.sep).join('/'), source);
        })
      );
    }
  }
  return files;
}

async function changedSnapshot(
  project: RunHopTarget,
  outputs: string[],
  changed: readonly string[],
  cancellation: vscode.CancellationToken,
  overwriteSavedFiles: boolean
): Promise<Map<string, Source>> {
  const root = project.service.baseDir;
  const canonical = await realpath(root);
  const source = new Map<string, Source>();
  for (const file of changed) {
    checkCancelled(cancellation);
    if (
      !isLocalPathAtOrUnder(root, file) ||
      sourceIgnored(project, file, outputs) ||
      (!overwriteSavedFiles && !(await waitForDocumentClean(file, cancellation)))
    ) {
      continue;
    }
    const info = overwriteSavedFiles
      ? await localSource(file)
      : await waitForStableSource(file, cancellation);
    if (!info) continue;
    const resolved = await realpath(file).catch(error => {
      if (!isNotFoundError(error)) throw error;
    });
    if (resolved && isLocalPathAtOrUnder(canonical, resolved)) {
      source.set(path.relative(root, file).split(path.sep).join('/'), info);
    }
  }
  return source;
}

async function sourceDigest(file: string, cancellation: vscode.CancellationToken) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    checkCancelled(cancellation);
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function localDigest(file: string, expected: Source, cancellation: vscode.CancellationToken) {
  const digest = await sourceDigest(file, cancellation);
  if ((await localSource(file))?.fingerprint !== expected.fingerprint) {
    throw new Error('Source changed during synchronization while reading ' + file + '.');
  }
  return digest;
}

async function downloadRemoteFile(
  remote: Pick<FileSystem, 'get'>,
  remotePath: string,
  localPath: string,
  cancellation: vscode.CancellationToken
): Promise<void> {
  await mkdir(path.dirname(localPath), { recursive: true });
  const temporary = localPath + '.' + randomUUID() + '.runhop-download';
  try {
    await pipeline(await remote.get(remotePath), createWriteStream(temporary));
    checkCancelled(cancellation);
    await rename(temporary, localPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readBaseline(file: string): Promise<Baseline | undefined> {
  try {
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      Object.values(snapshot).every(
        value =>
          value &&
          typeof value === 'object' &&
          typeof (value as Baseline[string]).local === 'string' &&
          typeof (value as Baseline[string]).remote === 'string' &&
          typeof (value as Baseline[string]).sha256 === 'string'
      )
    ) {
      return snapshot;
    }
  } catch (error) {
    if (!isNotFoundError(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

async function writeBaseline(file: string, snapshot: Baseline): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function baselineName(project: ProjectTransfer): string {
  const id = createHash('sha256')
    .update(
      project.service.workspace + '\0' + project.service.baseDir + '\0' + projectTransferKey(project)
    )
    .digest('hex');
  return id + '.v2.json';
}

function baselineDirectory(project: ProjectTransfer): string {
  return path.join(project.service.workspace, '.vscode', 'runhop-state', 'source-baselines');
}

export function createIncrementalSync(legacyStorage?: vscode.Uri) {
  const legacyDirectory = legacyStorage
    ? vscode.Uri.joinPath(legacyStorage, 'source-baselines').fsPath
    : undefined;

  async function hasBaseline(project: ProjectTransfer): Promise<boolean> {
    const key = path.join(baselineDirectory(project), baselineName(project));
    try {
      if (!(await lstat(key + '.complete')).isFile()) return false;
      return (await readBaseline(key)) !== undefined;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return false;
    }
  }

  async function sync(
    project: ProjectTransfer,
    outputs: string[],
    python: string,
    cancellation: vscode.CancellationToken,
    onStatus: (message: string) => void,
    changedFiles?: readonly string[],
    options: SyncOptions = {}
  ): Promise<{
    uploaded: number;
    restored: number;
    conflicts: SyncConflict[];
    errors?: Map<string, string>;
  }> {
    const policy = options.policy ?? 'safe';
    const overwriteSavedFiles = Boolean(
      changedFiles && policy === 'force_upload' && options.overwriteSavedFiles
    );
    const checkSaved = () => {
      if (!changedFiles) requireSavedProjectFiles(project, outputs);
    };
    checkSaved();
    const name = baselineName(project);
    const key = path.join(baselineDirectory(project), name);
    const legacyKey = legacyDirectory ? path.join(legacyDirectory, name) : undefined;
    const localBaseline = await readBaseline(key);
    const legacyBaseline =
      localBaseline === undefined && legacyKey && legacyKey !== key
        ? await readBaseline(legacyKey)
        : undefined;
    const baseline = localBaseline ?? legacyBaseline ?? Object.create(null);
    const migrated = localBaseline === undefined && legacyBaseline !== undefined;
    const verified: Baseline = Object.assign(
      Object.create(null),
      changedFiles || options.scope ? baseline : {}
    );
    const wholeProject =
      !changedFiles &&
      !options.refreshOnly &&
      (!options.scope || options.scope === project.service.baseDir);
    const persist = async (complete = false) => {
      if (
        migrated ||
        (complete && localBaseline === undefined) ||
        Object.keys(baseline).length !== Object.keys(verified).length ||
        Object.entries(verified).some(
          ([file, info]) =>
            baseline[file]?.local !== info.local || baseline[file]?.remote !== info.remote
        )
      ) {
        await writeBaseline(key, verified);
      }
      if (migrated && legacyKey && legacyKey !== key) {
        await rm(legacyKey, { force: true });
      }
      if (complete) {
        await writeFile(key + '.complete', '', { flag: 'wx' }).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
    };
    onStatus('Checking saved project files…');
    const source = changedFiles
      ? await changedSnapshot(project, outputs, changedFiles, cancellation, overwriteSavedFiles)
      : await localSnapshot(project, outputs, cancellation, options.scope);
    const hasTrackedFiles = Object.keys(baseline).some(file => {
      const localPath = path.join(project.service.baseDir, ...file.split('/'));
      return !options.scope || isLocalPathAtOrUnder(options.scope, localPath);
    });
    if (!source.size && !hasTrackedFiles) {
      if (wholeProject) await persist(true);
      return { uploaded: 0, restored: 0, conflicts: [] };
    }
    const local = (file: string) => path.join(project.service.baseDir, ...file.split('/'));
    const { fs, client } = await connectSsh(project.service, project.config);
    checkCancelled(cancellation);
    await fs.ensureDir(project.config.remotePath);
    const root = await resolveRemotePath(client, project.config.remotePath);
    const inspect = async (files: Inspection[]): Promise<(RemoteSource | null)[]> => {
      checkCancelled(cancellation);
      const command =
        'exec ' + [python, '-I', '-S', '-c', inspectScript, root].map(quoteShell).join(' ');
      const result = await execCommand(client.getRawClient(), command, {
        input: JSON.stringify(files),
        timeout: project.config.operationTimeout || 60_000,
      });
      checkCancelled(cancellation);
      if (result.timedOut || result.code !== 0) {
        const detail = result.timedOut ? 'Timed out.' : result.stderr.trim();
        throw new Error(
          'Unable to verify the remote project on ' + project.config.host + '. ' + detail
        );
      }
      const response = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
      if (
        !Array.isArray(response) ||
        response.length !== files.length ||
        response.some(
          entry =>
            entry !== null &&
            (typeof entry?.fingerprint !== 'string' ||
              (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256)))
        )
      ) {
        throw new Error('The remote source verification returned invalid data.');
      }
      return response;
    };

    onStatus('Verifying ' + source.size + ' remote files on ' + project.config.host + '…');
    const files: Inspection[] = overwriteSavedFiles
      ? []
      : [...source].map(([file, info]) => [
          file,
          info.size,
          baseline[file]?.local === info.fingerprint ? baseline[file].remote : null,
          Number(baseline[file]?.remote.split(':')[2] ?? -1),
        ]);
    const changedSet = changedFiles
      ? new Set(changedFiles.map(file => path.relative(project.service.baseDir, file).split(path.sep).join('/')))
      : undefined;
    for (const file of Object.keys(baseline)) {
      const localPath = path.join(project.service.baseDir, ...file.split('/'));
      if (
        !source.has(file) &&
        (!changedSet || changedSet.has(file)) &&
        (!overwriteSavedFiles || !sourceIgnored(project, localPath, outputs)) &&
        (!changedFiles || !isDirty(localPath)) &&
        (!options.scope || isLocalPathAtOrUnder(options.scope, localPath))
      ) {
        files.push([file, 0, baseline[file].remote, Number(baseline[file].remote.split(':')[2] ?? -1)]);
      }
    }
    const remote = files.length ? await inspect(files) : [];
    const updates = new Map<string, { info: Source; digest: string; remote: string | null }>();
    if (overwriteSavedFiles) {
      for (const [file, info] of source) updates.set(file, { info, digest: '', remote: null });
    }
    const deletions = new Set<string>();
    const localDeletions = new Set<string>();
    const downloads = new Set<string>();
    const conflicts: SyncConflict[] = [];
    const pending = new Map<string, { conflict: SyncConflict; info?: Source; digest?: string; remote?: RemoteSource | null }>();
    const restored = 0;
    for (const [index, [file]] of files.entries()) {
      checkCancelled(cancellation);
      const previousRemote = remote[index];
      const info = source.get(file);
      const saved = baseline[file];
      if (!info) {
        if (!previousRemote) {
          delete verified[file];
        } else {
          const conflict: SyncConflict = {
            file,
            kind: 'local_deleted',
            localFingerprint: null,
            remoteFingerprint: previousRemote.fingerprint,
            baselineLocalFingerprint: saved?.local ?? null,
            baselineRemoteFingerprint: saved?.remote ?? null,
            localSha256: null,
            remoteSha256: previousRemote.sha256 ?? null,
            baselineSha256: saved?.sha256 ?? null,
          };
          conflicts.push(conflict);
          pending.set(file, { conflict, remote: previousRemote });
          if (policy === 'force_upload' && options.deleteRemoteOnUpload) deletions.add(file);
        }
        continue;
      }
      const digest = await localDigest(local(file), info, cancellation);
      const remoteChanged = saved
        ? !previousRemote ||
          (previousRemote.fingerprint !== saved.remote && previousRemote.sha256 !== saved.sha256)
        : Boolean(previousRemote);
      const localChanged = !saved || info.fingerprint !== saved.local;
      if (
        policy === 'force_download' &&
        saved &&
        previousRemote &&
        localChanged &&
        previousRemote.sha256 !== digest
      ) {
        downloads.add(file);
        continue;
      }
    if (
      previousRemote &&
      (previousRemote.sha256 === digest ||
        (previousRemote.fingerprint === saved?.remote && saved.sha256 === digest))
    ) {
        verified[file] = {
          local: info.fingerprint,
          remote: previousRemote.fingerprint,
          sha256: digest,
        };
      } else if (!remoteChanged) {
        if (options.refreshOnly && previousRemote) {
          verified[file] = {
            local: info.fingerprint,
            remote: previousRemote.fingerprint,
            sha256: digest,
          };
        } else if (!options.refreshOnly) {
          updates.set(file, { info, digest, remote: previousRemote?.fingerprint ?? null });
        }
      } else if (saved && !localChanged && !previousRemote) {
        const conflict: SyncConflict = {
          file,
          kind: 'remote_deleted',
          localFingerprint: info.fingerprint,
          remoteFingerprint: null,
          baselineLocalFingerprint: saved.local,
          baselineRemoteFingerprint: saved.remote,
          localSha256: digest,
          remoteSha256: null,
          baselineSha256: saved.sha256,
        };
        conflicts.push(conflict);
        pending.set(file, { conflict, info, digest, remote: previousRemote });
      } else {
        const conflict: SyncConflict = {
          file,
          kind: !saved
            ? 'untracked_remote'
            : !previousRemote
              ? 'local_modified'
            : localChanged
              ? 'both_modified'
              : 'remote_modified',
          localFingerprint: info.fingerprint,
          remoteFingerprint: previousRemote?.fingerprint ?? null,
          baselineLocalFingerprint: saved?.local ?? null,
          baselineRemoteFingerprint: saved?.remote ?? null,
          localSha256: digest,
          remoteSha256: previousRemote?.sha256 ?? null,
          baselineSha256: saved?.sha256 ?? null,
        };
        conflicts.push(conflict);
        pending.set(file, { conflict, info, digest, remote: previousRemote });
        if (policy === 'force_upload') {
          updates.set(file, { info, digest, remote: previousRemote?.fingerprint ?? null });
        }
      }
      if (saved && !previousRemote && localChanged && policy === 'force_upload') {
        updates.set(file, { info, digest, remote: null });
      }
    }
    if (options.resolveConflict && (policy === 'safe' || policy === 'interactive')) {
      for (const entry of pending.values()) {
        const action = await options.resolveConflict(entry.conflict);
        if (action === 'local') {
          if (entry.info && entry.digest !== undefined) {
            updates.set(entry.conflict.file, {
              info: entry.info,
              digest: entry.digest,
              remote: entry.remote?.fingerprint ?? null,
            });
          } else {
            deletions.add(entry.conflict.file);
          }
        } else if (action === 'remote' && entry.remote) {
          downloads.add(entry.conflict.file);
        } else if (action === 'remote' && !entry.remote) {
          delete verified[entry.conflict.file];
          localDeletions.add(entry.conflict.file);
        } else if (action === 'baseline') {
          if (entry.remote) {
            verified[entry.conflict.file] = {
              local: entry.info?.fingerprint ?? baseline[entry.conflict.file]?.local ?? entry.remote.fingerprint,
              remote: entry.remote.fingerprint,
              sha256: entry.remote.sha256 ?? '',
            };
          } else {
            delete verified[entry.conflict.file];
          }
        }
        if (action !== 'skip') {
          const index = conflicts.indexOf(entry.conflict);
          if (index >= 0) conflicts.splice(index, 1);
        }
      }
    } else if (policy === 'force_download') {
      for (const entry of pending.values()) {
        if (entry.remote) downloads.add(entry.conflict.file);
        else {
          delete verified[entry.conflict.file];
          localDeletions.add(entry.conflict.file);
        }
      }
      conflicts.length = 0;
    } else if (policy === 'force_upload') {
      const unresolved = options.deleteRemoteOnUpload
        ? []
        : conflicts.filter(conflict => conflict.kind === 'local_deleted');
      conflicts.length = 0;
      conflicts.push(...unresolved);
    }
    for (const file of deletions) {
      checkCancelled(cancellation);
      try {
        await fs.unlink(path.posix.join(root, ...file.split('/')));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      delete verified[file];
    }
    for (const file of localDeletions) {
      checkCancelled(cancellation);
      await rm(local(file), { force: true });
      delete verified[file];
    }
    for (const file of downloads) {
      checkCancelled(cancellation);
      const remotePath = path.posix.join(root, ...file.split('/'));
      const remoteEntry = remote[files.findIndex(entry => entry[0] === file)];
      if (!remoteEntry) {
        await rm(local(file), { force: true });
        delete verified[file];
        continue;
      }
      await downloadRemoteFile(fs, remotePath, local(file), cancellation);
      const downloaded = await localSource(local(file));
      if (!downloaded) throw new Error('The remote file disappeared during download: ' + file);
      const digest = await localDigest(local(file), downloaded, cancellation);
      verified[file] = {
        local: downloaded.fingerprint,
        remote: remoteEntry.fingerprint,
        sha256: remoteEntry.sha256 ?? digest,
      };
    }
    if (
      conflicts.length &&
      (policy === 'safe' || (policy === 'interactive' && !options.resolveConflict)) &&
      !changedFiles &&
      !options.refreshOnly
    ) {
      const names = conflicts.slice(0, 3).map(conflict => conflict.file).join(', ');
      const suffix = conflicts.length > 3 ? ' and ' + (conflicts.length - 3) + ' more' : '';
      throw new Error(
        'Remote source changed on ' +
          project.config.host +
          ': ' +
          names +
          suffix +
          '. Review the remote changes or use RunHop Upload to replace them before launching.'
      );
    }
    if (changedFiles) {
      let uploaded = 0;
      const errors = new Map<string, string>();
      const finished = project.onFinished(({ task, error }) => {
        if (error && !task.isCancelled()) errors.set(task.srcFsPath, error.message);
      });
      const command =
        'exec ' + [python, '-I', '-S', '-c', publishScript, root].map(quoteShell).join(' ');
      const relativePath = (file: string) =>
        path.relative(project.service.baseDir, file).split(path.sep).join('/');
      try {
        await uploadSourceFiles(project, [...updates.keys()].map(local), {
          cancellation,
          showProgress: false,
          captureSource: overwriteSavedFiles
            ? async (file, snapshot) => {
                const next = updates.get(relativePath(file))!;
                try {
                  await copyFile(file, snapshot, constants.COPYFILE_FICLONE);
                } catch (error) {
                  if (!isNotFoundError(error)) throw error;
                }
                if ((await localSource(file))?.fingerprint !== next.info.fingerprint) {
                  throw new Error('Source changed during synchronization while reading ' + file + '.');
                }
                next.digest = await sourceDigest(snapshot, cancellation);
              }
            : undefined,
          async publish(file, staging) {
            const relative = relativePath(file);
            const next = updates.get(relative)!;
            if (
              !overwriteSavedFiles &&
              (isDirty(file) || (await localSource(file))?.fingerprint !== next.info.fingerprint)
            ) {
              throw new Error('The local source changed while uploading ' + relative + '.');
            }
            checkCancelled(cancellation);
            const { client: connected } = await connectSsh(project.service, project.config);
            const result = await execCommand(connected.getRawClient(), command, {
              input: JSON.stringify([
                relative,
                staging,
                next.remote,
                overwriteSavedFiles ? null : next.digest,
              ]),
              timeout: project.config.operationTimeout || 60_000,
            });
            if (result.timedOut || result.code !== 0) {
              throw new Error(
                result.timedOut
                  ? 'Timed out publishing ' + relative + '.'
                  : result.stderr.trim().split('\n').at(-1) || 'Could not publish ' + relative + '.'
              );
            }
            const fingerprint: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
            // The optional baseline describes the particular file we published.
            if (overwriteSavedFiles && fingerprint === null) {
              uploaded++;
              return;
            }
            if (typeof fingerprint !== 'string' || !/^-?\d+(?::-?\d+){4}$/.test(fingerprint)) {
              throw new Error('The remote source verification returned invalid data.');
            }
            verified[relative] = {
              local: next.info.fingerprint,
              remote: fingerprint,
              sha256: next.digest,
            };
            uploaded++;
          },
        });
      } catch (error) {
        if (error instanceof vscode.CancellationError || !errors.size) throw error;
      } finally {
        finished.dispose();
        await persist();
      }
      return { uploaded, restored, conflicts, errors };
    }
    checkSaved();
    let complete = false;
    try {
      if (updates.size) {
        const entries = [...updates];
        await uploadSourceFiles(
          project,
          entries.map(([file]) => local(file)),
          {
            cancellation,
            onStatus,
          }
        );
        onStatus('Verifying uploaded files…');
        const deployed = await inspect(entries.map(([file, { info }]) => [file, info.size, null]));
        for (const [index, [file, { info, digest }]] of entries.entries()) {
          const uploaded = deployed[index];
          if (
            uploaded?.sha256 !== digest ||
            (await localSource(local(file)))?.fingerprint !== info.fingerprint
          ) {
            throw new Error(
              'Source changed during deployment of ' + file + '. Run again after saving.'
            );
          }
          verified[file] = { local: info.fingerprint, remote: uploaded.fingerprint, sha256: digest };
        }
      }
      checkCancelled(cancellation);
      checkSaved();
      complete = wholeProject && conflicts.length === 0;
    } finally {
      await persist(complete);
    }
    return { uploaded: updates.size, restored, conflicts };
  }

  return { sync, hasBaseline };
}
