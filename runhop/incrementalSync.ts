import { createHash, randomUUID } from 'crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isNotFoundError } from './transport/core';
import type { RunHopTarget } from './targets';
import {
  ProjectTransfer,
  projectTransferKey,
  requireSavedProjectFiles,
  sourceIgnored,
  syncSource,
  uploadSourceFiles,
} from './transfers';

type Snapshot = Record<string, string>;

export async function sourceFingerprint(file: string): Promise<string | undefined> {
  try {
    const stat = await lstat(file, { bigint: true });
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function localSnapshot(
  target: RunHopTarget,
  outputs: string[],
  cancellation?: vscode.CancellationToken
): Promise<Snapshot> {
  const root = target.service.baseDir;
  const files: [string, string][] = [];
  const directories = [root];
  while (directories.length) {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (directory !== root && isNotFoundError(error)) {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (sourceIgnored(target, file, outputs)) {
        continue;
      }
      if (entry.isDirectory() && !target.ignoreDirectory(file)) {
        directories.push(file);
      } else if (entry.isFile()) {
        const fingerprint = await sourceFingerprint(file);
        if (fingerprint !== undefined) {
          files.push([path.relative(root, file), fingerprint]);
        }
      }
    }
  }
  return Object.fromEntries(files);
}

export function createIncrementalSync(storage: vscode.Uri) {
  const directory = vscode.Uri.joinPath(storage, 'source-baselines').fsPath;

  function baselinePath(target: RunHopTarget): string {
    const id = createHash('sha256')
      .update(
        target.service.workspace + '\0' + target.service.baseDir + '\0' + projectTransferKey(target)
      )
      .digest('hex');
    return path.join(directory, id + '.v1.json');
  }

  async function readBaseline(file: string): Promise<Snapshot | undefined> {
    try {
      const snapshot: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        !Array.isArray(snapshot) &&
        Object.values(snapshot).every(value => typeof value === 'string')
      ) {
        return snapshot as Snapshot;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async function writeBaseline(file: string, snapshot: Snapshot): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function rememberUpload(
    target: RunHopTarget,
    file: string,
    fingerprint: string
  ): Promise<void> {
    const key = baselinePath(target);
    const baseline = await readBaseline(key);
    if (baseline) {
      const relative = path.relative(target.service.baseDir, file);
      if (baseline[relative] !== fingerprint) {
        await writeBaseline(key, { ...baseline, [relative]: fingerprint });
      }
    }
  }

  async function rememberFullSync(
    target: RunHopTarget,
    outputs: string[],
    transfer: () => Promise<void>
  ): Promise<void> {
    const source = await localSnapshot(target, outputs);
    await transfer();
    await writeBaseline(baselinePath(target), source);
  }

  async function sync(
    project: ProjectTransfer,
    outputs: string[],
    cancellation: vscode.CancellationToken,
    onStatus: (message: string) => void
  ): Promise<void> {
    const key = baselinePath(project);
    const baseline = await readBaseline(key);
    onStatus('Checking local changes…');
    const source = await localSnapshot(project, outputs, cancellation);
    if (!baseline) {
      requireSavedProjectFiles(project, outputs);
      onStatus('Preparing the first deployment for this target…');
      await syncSource(project, outputs, { cancellation, onStatus });
      await writeBaseline(key, source);
      return;
    }
    const files = Object.keys(source);
    const changed = files.filter(file => baseline[file] !== source[file]);
    if (changed.length) {
      await uploadSourceFiles(
        project,
        changed.map(file => path.join(project.service.baseDir, file)),
        {
          cancellation,
          onStatus,
        }
      );
    }
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (changed.length || files.length !== Object.keys(baseline).length) {
      await writeBaseline(key, source);
    }
  }

  return { sync, rememberFullSync, rememberUpload };
}

export type IncrementalSync = ReturnType<typeof createIncrementalSync>;
