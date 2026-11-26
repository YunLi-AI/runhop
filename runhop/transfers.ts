import * as path from 'path';
import { lstat, mkdtemp, realpath, rm } from 'fs/promises';
import type { Stats } from 'fs';
import { tmpdir } from 'node:os';
import { FileService, FileType, TransferTask, isNotFoundError } from './transport/core';
import { createBackupHook } from './transport/core/backup';
import { clearLocalHashCache, ContentHasher } from './transport/core/contentHash';
import { planTransfer, TransferDirection } from './transport/core/transferPlan';
import type { FileSystem } from './transport/core/fs';
import { isLocalPathAtOrUnder } from './paths';
import { formatBytes, formatDuration } from './transport/utils';
import * as vscode from 'vscode';
import { resolveRemotePath } from './debuggerHelper';
import { connectSsh, RunHopTarget } from './targets';

export interface ProjectTransfer extends RunHopTarget {
  onFinished: vscode.Event<{ error: Error | null; task: TransferTask }>;
  dispose(): void;
}

export function projectTransfer(target: RunHopTarget): ProjectTransfer {
  const finished = new vscode.EventEmitter<{ error: Error | null; task: TransferTask }>();
  const unsubscribe = target.service.afterTransfer((error, task) => finished.fire({ error, task }));
  return {
    ...target,
    onFinished: finished.event,
    dispose() {
      unsubscribe();
      finished.dispose();
    },
  };
}

type Scheduler = ReturnType<FileService['createTransferScheduler']>;
type DescribeProgress = () => string;
type ReportStatus = (message: string) => void;

interface TransferDisplay {
  verb: 'Uploading' | 'Downloading';
  fileLabel(task: TransferTask): string;
  emptyMessage: string;
  onStatus?: ReportStatus;
}

export function projectTransferKey({
  service,
  config,
}: Pick<ProjectTransfer, 'service' | 'config'>): string {
  return service.getConnectionId(config) + '\0' + path.posix.normalize(config.remotePath);
}

async function transferBatch(
  project: ProjectTransfer,
  title: string,
  prepare: (
    enqueue: (task: TransferTask) => void,
    cancelled: () => boolean,
    show: (describe: DescribeProgress) => void
  ) => Promise<void>,
  sessionCancellation?: vscode.CancellationToken,
  display?: TransferDisplay
): Promise<void> {
  const { config, service } = project;
  const scheduler: Scheduler = service.createTransferScheduler(
    config.concurrency,
    config.retry,
    config.stallTimeout,
    config
  );
  const tasks = new Set<TransferTask>();
  const errors: Error[] = [];
  let totalBytes = 0;
  let totalKnown = true;
  let completedFiles = 0;
  let completedBytes = 0;
  const subscription = project.onFinished(({ task, error }) => {
    if (!tasks.has(task) || task.isCancelled()) {
      return;
    }
    if (error) {
      errors.push(error);
    } else {
      completedFiles++;
      completedBytes += task.transferredBytes || task.totalBytes || 0;
    }
  });

  function describeTransfer(display: TransferDisplay): string {
    const current = service.getPendingTransferTasks().filter(task => tasks.has(task));
    const transferred = current.reduce((sum, task) => sum + task.transferredBytes, completedBytes);
    const rate = current.reduce((sum, task) => sum + (task.bytesPerSecond ?? 0), 0);
    return [
      display.verb + ' ' + completedFiles + '/' + tasks.size + ' files',
      formatBytes(transferred) +
        (totalKnown ? ' / ' + formatBytes(Math.max(transferred, totalBytes)) : ''),
      current[0] && display.fileLabel(current[0]),
      rate > 0 && formatBytes(rate) + '/s',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  async function run(
    cancellation?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<void> {
    const cancelSubscription = cancellation?.onCancellationRequested(() => scheduler.stop());
    const sessionSubscription = sessionCancellation?.onCancellationRequested(() =>
      scheduler.stop()
    );
    const cancelled = () =>
      cancellation?.isCancellationRequested === true ||
      sessionCancellation?.isCancellationRequested === true;
    const started = Date.now();
    let describe: DescribeProgress | undefined;
    let lastMessage = '';
    let finished = false;
    function report(): void {
      if (finished || !describe || cancelled() || scheduler.isStopped()) {
        return;
      }
      const message = describe() + ' · ' + formatDuration((Date.now() - started) / 1000);
      if (lastMessage !== message) {
        lastMessage = message;
        progress?.report({ message });
        display?.onStatus?.(message);
      }
    }
    function show(next: DescribeProgress): void {
      describe = next;
      report();
    }
    const timer = display ? setInterval(report, 1000) : undefined;
    try {
      if (cancelled()) {
        throw new vscode.CancellationError();
      }
      await prepare(
        task => {
          tasks.add(task);
          totalBytes += task.totalBytes ?? 0;
          totalKnown &&= task.totalBytes !== undefined;
          scheduler.add(task);
        },
        () => cancelled() || scheduler.isStopped(),
        show
      );
      if (display) {
        show(tasks.size ? () => describeTransfer(display) : () => display.emptyMessage);
      }
      await scheduler.run();
      if (cancelled() || scheduler.isStopped()) {
        throw new vscode.CancellationError();
      }
      if (errors.length) {
        throw new Error(title + ' failed: ' + errors[0].message);
      }
      report();
    } catch (error) {
      if (cancelled() && !(error instanceof vscode.CancellationError)) {
        throw new vscode.CancellationError();
      }
      throw error;
    } finally {
      finished = true;
      clearInterval(timer);
      cancelSubscription?.dispose();
      sessionSubscription?.dispose();
    }
  }

  try {
    if (display) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (progress, cancellation) => run(cancellation, progress)
      );
    } else {
      await run();
    }
  } finally {
    subscription.dispose();
    scheduler.stop();
  }
}

const syncExclusions = new Set([
  '.git',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  '.env',
  '.DS_Store',
]);

export function sourceIgnored(
  project: Pick<ProjectTransfer, 'service' | 'config'>,
  local: string,
  outputs: string[]
): boolean {
  const relative = path.relative(project.service.baseDir, local);
  if (!relative) {
    return false;
  }
  const parts = relative.split(path.sep);
  const posix = parts.join('/');
  return Boolean(
    parts.some(part => syncExclusions.has(part) || part.startsWith('.env.')) ||
    outputs.some(output => posix === output || posix.startsWith(output + '/')) ||
    project.config.ignore?.(local)
  );
}

export function requireSavedProjectFiles(
  target: RunHopTarget,
  outputs: string[],
  scope = target.service.baseDir
): void {
  const pending = vscode.workspace.textDocuments.find(
    doc =>
      doc.isDirty &&
      doc.uri.scheme === 'file' &&
      isLocalPathAtOrUnder(scope, doc.uri.fsPath) &&
      !sourceIgnored(target, doc.uri.fsPath, outputs)
  );
  if (pending) {
    throw new Error(
      'Save ' +
        path.basename(pending.uri.fsPath) +
        ' before syncing, running or debugging with RunHop.'
    );
  }
}

export async function syncSource(
  project: ProjectTransfer,
  outputs: string[],
  {
    cancellation,
    onStatus,
    scope = project.service.baseDir,
  }: {
    cancellation?: vscode.CancellationToken;
    onStatus?: ReportStatus;
    scope?: string;
  } = {}
): Promise<void> {
  const { service, config } = project;
  const label = (file: string) => path.relative(service.baseDir, file) || '.';
  await transferBatch(
    project,
    'RunHop: Synchronizing project files · ' + config.host,
    async (enqueue, cancelled, show) => {
      show(() => 'Connecting to ' + config.host);
      const { fs: remote, client } = await connectSsh(service, config);
      if (cancelled()) {
        return;
      }
      await remote.ensureDir(config.remotePath);
      const root = await resolveRemotePath(client, config.remotePath);
      const selected = label(scope).split(path.sep).join('/');
      if (selected !== '.') {
        await projectPathType(remote, root, selected).catch(error => {
          if (!isNotFoundError(error)) {
            throw error;
          }
        });
      }
      const skipped: { fsPath: string; size: number }[] = [];
      const local = service.getLocalFileSystem();
      let directories = 0;
      let files = 0;
      let directoryLabel = '.';
      const comparisons = new Set<string>();
      let reportedComparison = false;

      // A formatter or tool can preserve size and mtime when it edits a file.
      // Recheck actual content at each launch instead of reusing a previous hash.
      clearLocalHashCache();
      const hasher = new ContentHasher({ concurrency: config.concurrency, isCancelled: cancelled });
      const describe = () => {
        const current = comparisons.values().next().value;
        const count = directories + ' folders scanned, ' + files + ' files found';
        if (current !== undefined) {
          return (
            'Comparing file contents · ' +
            current +
            ' · ' +
            hasher.stats.files +
            ' hashes (' +
            formatBytes(hasher.stats.bytes) +
            ') · ' +
            count
          );
        }
        return 'Scanning project · ' + directoryLabel + ' · ' + count;
      };
      const compare = hasher.contentDiffers.bind(hasher);
      hasher.contentDiffers = async pairs => {
        if (!pairs.length) {
          return compare(pairs);
        }
        const first = pairs[0][0].entry.fspath;
        const current = label(pairs.length === 1 ? first : path.dirname(first));
        comparisons.add(current);
        if (!reportedComparison) {
          reportedComparison = true;
          show(describe);
        }
        try {
          return await compare(pairs);
        } finally {
          comparisons.delete(current);
        }
      };
      // Filter entries before the transfer engine measures them or creates remote directories.
      const listSource = async (directory: string) => {
        directoryLabel = label(directory);
        const entries = (await local.list(directory)).filter(
          file =>
            file.type !== FileType.SymbolicLink &&
            !sourceIgnored(project, file.fspath, outputs) &&
            (file.type !== FileType.Directory || !project.ignoreDirectory(file.fspath))
        );
        directories++;
        files += entries.filter(file => file.type !== FileType.Directory).length;
        return entries;
      };
      show(describe);
      await planTransfer(
        {
          srcFs: local,
          listSource,
          srcFsPath: scope,
          targetFs: remote,
          targetFsPath: path.posix.join(root, selected),
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          walkConcurrency: config.concurrency,
          skipped,
          hasher,
          token: { isCancelled: cancelled },
          transferOption: {
            useTempFile: true,
            openSsh: config.openSsh,
            transferMode: config.transferMode,
            batchConcurrency: config.concurrency,
            maxFileSize: config.maxFileSize,
            filePerm: config.filePerm,
            dirPerm: config.dirPerm,
            perserveTargetMode: !config.filePerm && !config.dirPerm,
            beforeOverwrite: createBackupHook({ ...config, remotePath: root }, service.baseDir),
          },
        },
        enqueue
      );
      if (skipped.length) {
        throw new Error('A source file exceeds maxFileSize: ' + skipped[0].fsPath);
      }
    },
    cancellation,
    {
      verb: 'Uploading',
      fileLabel: task => label(task.srcFsPath),
      emptyMessage: 'Project files are up to date',
      onStatus,
    }
  );
}

export async function uploadSourceFiles(
  project: ProjectTransfer,
  files: string[],
  {
    cancellation,
    showProgress = true,
    onStatus,
    publish,
    captureSource,
  }: {
    cancellation?: vscode.CancellationToken;
    showProgress?: boolean;
    onStatus?: ReportStatus;
    publish?: (local: string, staging: string, destination: string) => Promise<void>;
    captureSource?: (local: string, snapshot: string) => Promise<void>;
  } = {}
): Promise<number> {
  if (!files.length) {
    return 0;
  }
  const { service, config } = project;
  const base = await realpath(service.baseDir);
  const sources: { file: string; stat: Stats }[] = [];
  for (const file of files) {
    if (cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || !isLocalPathAtOrUnder(base, await realpath(file))) {
        continue;
      }
      if (config.maxFileSize && stat.size > config.maxFileSize * 1024 * 1024) {
        throw new Error('The source file exceeds maxFileSize: ' + file);
      }
      sources.push({ file, stat });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  if (!sources.length) {
    return 0;
  }
  const snapshots = captureSource && (await mkdtemp(path.join(tmpdir(), 'runhop-upload-')));
  return transferBatch(
    project,
    showProgress ? 'RunHop: Uploading changed files · ' + config.host : 'RunHop: Upload on save',
    async (enqueue, cancelled, show) => {
      if (showProgress) {
        show(() => 'Connecting to ' + config.host);
      }
      const { fs: remote, client } = await connectSsh(service, config);
      if (cancelled()) {
        return;
      }
      await remote.ensureDir(config.remotePath);
      const root = await resolveRemotePath(client, config.remotePath);
      const beforeOverwrite = createBackupHook({ ...config, remotePath: root }, service.baseDir);
      const checked = new Set<string>();
      const folders = new Set([root]);
      for (const [index, { file, stat }] of sources.entries()) {
        if (cancelled()) {
          return;
        }
        const source = path.relative(service.baseDir, file).split(path.sep);
        const destination = path.posix.join(root, ...source);
        let remotePath = root;
        for (const segment of source) {
          remotePath = path.posix.join(remotePath, segment);
          if (checked.has(remotePath)) {
            continue;
          }
          try {
            if ((await remote.lstat(remotePath)).type === FileType.SymbolicLink) {
              throw new Error('The remote project path contains a symbolic link: ' + remotePath);
            }
          } catch (error) {
            if (!isNotFoundError(error)) {
              throw error;
            }
            checked.add(remotePath);
            break;
          }
          checked.add(remotePath);
        }
        const directory = path.posix.dirname(destination);
        if (!folders.has(directory)) {
          await remote.ensureDir(directory);
          folders.add(directory);
        }
        const readPath = snapshots && path.join(snapshots, String(index));
        if (readPath) await captureSource!(file, readPath);
        // Read the last saved version from disk, without saving an open editor.
        enqueue(
          new TransferTask(
            { fsPath: file, fileSystem: service.getLocalFileSystem(), readPath },
            { fsPath: destination, fileSystem: remote },
            {
              transferDirection: TransferDirection.LOCAL_TO_REMOTE,
              transferOption: {
                mtime: stat.mtimeMs,
                atime: stat.atimeMs,
                fallbackMode: stat.mode & 0o777,
                size: stat.size,
                filePerm: config.filePerm,
                dirPerm: config.dirPerm,
                useTempFile: true,
                transferMode: config.transferMode,
                batchConcurrency: config.concurrency,
                openSsh: config.openSsh,
                perserveTargetMode: !config.filePerm && !config.dirPerm,
                beforeOverwrite,
                publishStaged:
                  publish && ((staging, destination) => publish(file, staging, destination)),
              },
            }
          )
        );
      }
    },
    cancellation,
    showProgress
      ? {
          verb: 'Uploading',
          fileLabel: task => path.relative(service.baseDir, task.srcFsPath),
          emptyMessage: 'No files to upload',
          onStatus,
        }
      : undefined
  )
    .then(() => sources.length)
    .finally(async () => {
      if (snapshots) await rm(snapshots, { recursive: true, force: true });
    });
}

export async function uploadSavedFile(
  project: ProjectTransfer,
  file: string,
  cancellation?: vscode.CancellationToken,
  showProgress = false
): Promise<boolean> {
  return (await uploadSourceFiles(project, [file], { cancellation, showProgress })) > 0;
}

async function listDownloadEntries(remote: FileSystem, directory: string) {
  return (await remote.list(directory)).filter(file => {
    const { name, type } = file;
    if (name === '.' || name === '..' || (type !== FileType.File && type !== FileType.Directory)) {
      return false;
    }
    if (!name || /[\\/:\0]/.test(name) || file.fspath !== path.posix.join(directory, name)) {
      throw new Error('The server returned an unsupported download path.');
    }
    if (
      process.platform === 'win32' &&
      /[<>"|?*]|[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ) {
      throw new Error('The remote filename is unavailable on Windows: ' + name);
    }
    return true;
  });
}

export async function downloadProject(
  project: ProjectTransfer,
  destination: string,
  scope = project.service.baseDir
): Promise<void> {
  const { service, config } = project;
  await transferBatch(
    project,
    'RunHop: Downloading project · ' + config.host,
    async (enqueue, cancelled, show) => {
      show(() => 'Connecting to ' + config.host);
      const { fs: remote, client } = await connectSsh(service, config);
      const root = await resolveRemotePath(client, config.remotePath);
      const selected = path.relative(service.baseDir, scope).split(path.sep).join('/');
      const selectedType = await projectPathType(remote, root, selected);
      const remotePath = path.posix.join(root, selected);
      if (
        sourceIgnored(project, scope, []) ||
        (selectedType === FileType.Directory && project.ignoreDirectory(scope))
      ) {
        throw new Error('The selected path is excluded by the project ignore rules.');
      }
      if (
        selectedType === FileType.File &&
        config.maxFileSize &&
        (await remote.lstat(remotePath)).size > config.maxFileSize * 1024 * 1024
      ) {
        throw new Error('The selected remote file exceeds maxFileSize: ' + selected);
      }
      let current = '.';
      show(() => 'Scanning remote project · ' + current);
      const listSource = async (directory: string) => {
        current = path.posix.relative(root, directory) || '.';
        return (await listDownloadEntries(remote, directory)).filter(file => {
          const relative = path.posix.relative(root, file.fspath);
          const local = path.join(service.baseDir, ...relative.split('/'));
          return (
            !sourceIgnored(project, local, []) &&
            (file.type !== FileType.Directory || !project.ignoreDirectory(local))
          );
        });
      };
      const skipped: { fsPath: string; size: number }[] = [];
      await planTransfer(
        {
          srcFs: remote,
          listSource,
          srcFsPath: remotePath,
          targetFs: service.getLocalFileSystem(),
          targetFsPath: path.join(destination, ...selected.split('/')),
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          walkConcurrency: config.concurrency,
          skipped,
          token: { isCancelled: cancelled },
          transferOption: {
            perserveTargetMode: false,
            maxFileSize: config.maxFileSize,
            transferMode: config.transferMode,
            batchConcurrency: config.concurrency,
          },
        },
        enqueue
      );
      if (skipped.length) {
        throw new Error('A remote file exceeds maxFileSize: ' + skipped[0].fsPath);
      }
    },
    undefined,
    {
      verb: 'Downloading',
      fileLabel: task => path.relative(destination, task.targetFsPath),
      emptyMessage: 'No project files to download',
    }
  );
}

export async function projectPathType(
  fs: FileSystem,
  root: string,
  relative: string
): Promise<FileType> {
  let current = root;
  const parts = relative ? relative.split('/') : [];
  let info = await fs.lstat(root);
  for (const part of parts) {
    current = fs.pathResolver.join(current, part);
    info = await fs.lstat(current);
    if (info.type === FileType.SymbolicLink) {
      throw new Error('Project transfers skip symbolic links: ' + current);
    }
  }
  if (info.type !== FileType.Directory && info.type !== FileType.File) {
    throw new Error('Select a regular file or folder in the project.');
  }
  return info.type;
}

export async function downloadResults(
  project: ProjectTransfer,
  outputs: string[],
  destination: string,
  onStatus?: ReportStatus
): Promise<void> {
  const { service, config } = project;
  const missing: string[] = [];
  await transferBatch(
    project,
    'RunHop: Downloading results · ' + config.host,
    async (enqueue, cancelled, show) => {
      show(() => 'Connecting to ' + config.host);
      const { fs: remote, client } = await connectSsh(service, config);
      const root = await resolveRemotePath(client, config.remotePath);
      for (const relative of outputs) {
        if (cancelled()) {
          return;
        }
        show(() => 'Preparing result downloads · ' + relative);
        const source = path.posix.join(root, relative);
        try {
          await projectPathType(remote, root, relative);
          await planTransfer(
            {
              srcFs: remote,
              listSource: directory => listDownloadEntries(remote, directory),
              srcFsPath: source,
              targetFs: service.getLocalFileSystem(),
              targetFsPath: path.join(destination, ...relative.split('/')),
              transferDirection: TransferDirection.REMOTE_TO_LOCAL,
              walkConcurrency: config.concurrency,
              token: { isCancelled: cancelled },
              transferOption: {
                perserveTargetMode: false,
                transferMode: config.transferMode,
                batchConcurrency: config.concurrency,
              },
            },
            enqueue
          );
        } catch (error) {
          if (isNotFoundError(error)) {
            missing.push(relative);
          } else {
            throw error;
          }
        }
      }
    },
    undefined,
    {
      verb: 'Downloading',
      fileLabel: task => path.relative(destination, task.targetFsPath),
      emptyMessage: 'No result files to download',
      onStatus,
    }
  );
  if (missing.length) {
    void vscode.window.showWarningMessage(
      'RunHop: Results were not produced: ' + missing.join(', ')
    );
  }
}
