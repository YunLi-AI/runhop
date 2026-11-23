import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveRemotePath } from './debuggerHelper';
import { isLocalPathAtOrUnder, quoteShell } from './paths';
import { connectSsh, type RunHopTarget } from './targets';
import { isNotFoundError } from './transport/core';
import { execCommand } from './transport/core/remote-client/exec';
import {
  type ProjectTransfer,
  projectTransferKey,
  requireSavedProjectFiles,
  sourceIgnored,
  uploadSourceFiles,
} from './transfers';

type Baseline = Record<string, { local: string; remote: string; sha256: string }>;
type Source = { fingerprint: string; size: number };
type RemoteSource = { fingerprint: string; sha256?: string };
type Inspection = [file: string, size: number, previous: string | null, previousSize?: number];

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

async function localSnapshot(
  project: RunHopTarget,
  outputs: string[],
  cancellation: vscode.CancellationToken
): Promise<Map<string, Source>> {
  const root = project.service.baseDir;
  const files = new Map<string, Source>();
  const directories = [root];
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
          const source = await localSource(file);
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
  cancellation: vscode.CancellationToken
): Promise<Map<string, Source>> {
  const root = project.service.baseDir;
  const canonical = await realpath(root);
  const source = new Map<string, Source>();
  for (const file of changed) {
    checkCancelled(cancellation);
    if (
      !isLocalPathAtOrUnder(root, file) ||
      sourceIgnored(project, file, outputs) ||
      isDirty(file)
    ) {
      continue;
    }
    const info = await localSource(file);
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

async function localDigest(file: string, expected: Source, cancellation: vscode.CancellationToken) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    checkCancelled(cancellation);
    digest.update(chunk);
  }
  if ((await localSource(file))?.fingerprint !== expected.fingerprint) {
    throw new Error('Source changed during synchronization. Run again after saving ' + file + '.');
  }
  return digest.digest('hex');
}

async function readBaseline(file: string): Promise<Baseline> {
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
    if (!(error instanceof SyntaxError) && !isNotFoundError(error)) throw error;
  }
  return Object.create(null);
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

export function createIncrementalSync(storage: vscode.Uri) {
  const directory = vscode.Uri.joinPath(storage, 'source-baselines').fsPath;

  async function sync(
    project: ProjectTransfer,
    outputs: string[],
    python: string,
    cancellation: vscode.CancellationToken,
    onStatus: (message: string) => void,
    changedFiles?: readonly string[]
  ): Promise<{
    uploaded: number;
    restored: number;
    conflicts: string[];
    errors?: Map<string, string>;
  }> {
    const checkSaved = () => {
      if (!changedFiles) requireSavedProjectFiles(project, outputs);
    };
    checkSaved();
    const id = createHash('sha256')
      .update(
        project.service.workspace +
          '\0' +
          project.service.baseDir +
          '\0' +
          projectTransferKey(project)
      )
      .digest('hex');
    const key = path.join(directory, id + '.v2.json');
    const baseline = await readBaseline(key);
    onStatus('Checking saved project files…');
    const source = changedFiles
      ? await changedSnapshot(project, outputs, changedFiles, cancellation)
      : await localSnapshot(project, outputs, cancellation);
    if (!source.size) return { uploaded: 0, restored: 0, conflicts: [] };
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
    const files: Inspection[] = [...source].map(([file, info]) => [
      file,
      info.size,
      baseline[file]?.local === info.fingerprint ? baseline[file].remote : null,
      Number(baseline[file]?.remote.split(':')[2] ?? -1),
    ]);
    const remote = await inspect(files);
    const verified: Baseline = Object.assign(Object.create(null), changedFiles ? baseline : {});
    const updates = new Map<string, { info: Source; digest: string; remote: string | null }>();
    const conflicts: string[] = [];
    let restored = 0;
    for (const [index, [file, , previous]] of files.entries()) {
      checkCancelled(cancellation);
      const previousRemote = remote[index];
      const info = source.get(file)!;
      if (previousRemote?.fingerprint === previous) {
        verified[file] = baseline[file];
        continue;
      }
      const digest = await localDigest(local(file), info, cancellation);
      if (previousRemote?.sha256 === digest) {
        verified[file] = {
          local: info.fingerprint,
          remote: previousRemote.fingerprint,
          sha256: digest,
        };
      } else if (
        previousRemote &&
        (baseline[file]
          ? previousRemote.fingerprint !== baseline[file].remote &&
            previousRemote.sha256 !== baseline[file].sha256
          : changedFiles)
      ) {
        conflicts.push(file);
      } else {
        if (!previousRemote && baseline[file]) restored++;
        updates.set(file, { info, digest, remote: previousRemote?.fingerprint ?? null });
      }
    }
    if (conflicts.length && !changedFiles) {
      const files = conflicts.slice(0, 3).join(', ');
      const suffix = conflicts.length > 3 ? ' and ' + (conflicts.length - 3) + ' more' : '';
      throw new Error(
        'Remote source changed on ' +
          project.config.host +
          ': ' +
          files +
          suffix +
          '. Review the remote changes or use RunHop Upload to replace them before launching.'
      );
    }
    const persist = async () => {
      if (
        Object.keys(baseline).length !== Object.keys(verified).length ||
        Object.entries(verified).some(
          ([file, info]) =>
            baseline[file]?.local !== info.local || baseline[file]?.remote !== info.remote
        )
      ) {
        await writeBaseline(key, verified);
      }
    };
    if (changedFiles) {
      let uploaded = 0;
      const errors = new Map<string, string>();
      const finished = project.onFinished(({ task, error }) => {
        if (error && !task.isCancelled()) errors.set(task.srcFsPath, error.message);
      });
      const command =
        'exec ' + [python, '-I', '-S', '-c', publishScript, root].map(quoteShell).join(' ');
      try {
        await uploadSourceFiles(project, [...updates.keys()].map(local), {
          cancellation,
          showProgress: false,
          async publish(file, staging) {
            const relative = path.relative(project.service.baseDir, file).split(path.sep).join('/');
            const next = updates.get(relative)!;
            if (isDirty(file) || (await localSource(file))?.fingerprint !== next.info.fingerprint) {
              throw new Error('The local source changed while uploading ' + relative + '.');
            }
            checkCancelled(cancellation);
            const { client: connected } = await connectSsh(project.service, project.config);
            const result = await execCommand(connected.getRawClient(), command, {
              input: JSON.stringify([relative, staging, next.remote, next.digest]),
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
    await persist();
    return { uploaded: updates.size, restored, conflicts: [] };
  }

  return { sync };
}
