import * as path from 'node:path';
import * as vscode from 'vscode';
import type { createIncrementalSync } from './incrementalSync';
import { artifactPath, isLocalPathAtOrUnder } from './paths';
import { chooseConflict, configuredOutputs } from './projectSync';
import {
  interpreterFor,
  optionsFor,
  readOptionalSettings,
  scriptKey,
  scriptLaunchOptions,
  settingsFile,
  type SyncPolicy,
  uploadPolicyFor,
} from './settings';
import { matchingTargets, resolveTarget, type RunHopTarget } from './targets';
import { projectTransfer, projectTransferKey, sourceIgnored } from './transfers';

type QueuedUpload = { key: string; completed: Promise<void> };
type PendingBatch = { workspace: string; uploads: Promise<QueuedUpload[]> };
type Destination = {
  key: string;
  target: RunHopTarget;
  python: string;
  policy: SyncPolicy;
  deleteRemoteOnUpload: boolean;
  files: Map<string, number>;
  outputs: Set<string>;
};
type Batch = { files: Map<string, number>; started: number; timer?: NodeJS.Timeout };

const quietTime = 350;
const maxWait = 1500;
const maxSourceChangeRetries = 3;

function isSourceChange(message: string): boolean {
  return /^(?:The local |ValueError: )?source changed (?:during synchronization|while uploading|during deployment)\b/i.test(
    message
  );
}

export function registerSaveUploads(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  queueTransfer: (key: string, transfer: () => Promise<void>) => Promise<void>,
  excludeOutputs: (key: string, outputs: string[]) => string[],
  incremental: ReturnType<typeof createIncrementalSync>
) {
  const scheduled = new Map<string, Batch>();
  const pending = new Set<PendingBatch>();
  const failures = new Map<string, Map<string, string>>();
  const observedChanges = new Map<string, Map<string, number>>();
  let nextRevision = 0;
  const cancellation = new vscode.CancellationTokenSource();
  const failureKey = (workspace: string, key: string) => workspace + '\0' + key;

  function warn(message: string): void {
    if (cancellation.token.isCancellationRequested) return;
    log.appendLine(message);
    void vscode.window.showWarningMessage(message);
  }

  function transfer(workspace: string, group: Destination): QueuedUpload {
    const { key, target, python, policy, deleteRemoteOnUpload, outputs } = group;
    const files = [...group.files.keys()];
    const completed = queueTransfer(key, async () => {
      if (cancellation.token.isCancellationRequested) return;
      const project = projectTransfer(target);
      const destination = failureKey(workspace, key);
      const previous = failures.get(destination) ?? new Map<string, string>();
      try {
        const excluded = excludeOutputs(key, [...outputs]);
        let result: Awaited<ReturnType<typeof incremental.sync>> | undefined;
        for (let attempt = 1; attempt <= maxSourceChangeRetries; attempt++) {
          try {
            result = await incremental.sync(
              project,
              excluded,
              python,
              cancellation.token,
              () => {},
              files,
              {
                policy,
                overwriteSavedFiles: policy === 'force_upload',
                deleteRemoteOnUpload,
                resolveConflict:
                  policy === 'safe' || policy === 'interactive'
                    ? conflict => chooseConflict(project, conflict)
                    : undefined,
              }
            );
          } catch (error) {
            if (!isSourceChange(error.message) || attempt === maxSourceChangeRetries) throw error;
            log.appendLine(
              'RunHop: Local source changed during synchronization. Retrying ' +
                (attempt + 1) +
                '/' +
                maxSourceChangeRetries +
                ' for ' +
                files.join(', ')
            );
            await new Promise<void>(resolve => setTimeout(resolve, 100 * attempt));
            continue;
          }
          const transient = [...(result.errors?.values() ?? [])].some(isSourceChange);
          if (!transient || attempt === maxSourceChangeRetries) break;
          log.appendLine(
            'RunHop: Local source changed during upload. Retrying ' +
              (attempt + 1) +
              '/' +
              maxSourceChangeRetries +
              ' for ' +
              files.join(', ')
          );
          await new Promise<void>(resolve => setTimeout(resolve, 100 * attempt));
        }
        const { uploaded, conflicts, errors } = result!;
        const conflictFiles = new Set(
          conflicts.map(conflict =>
            path.join(target.service.baseDir, ...conflict.file.split('/'))
          )
        );
        let newConflict = false;
        for (const file of files) {
          const error = errors?.get(file);
          if (error) {
            previous.set(file, error);
          } else if (conflictFiles.has(file)) {
            const message = 'Remote contents differ from the last synchronized version.';
            newConflict ||= previous.get(file) !== message;
            previous.set(file, message);
          } else {
            previous.delete(file);
          }
        }
        if (uploaded) {
          log.appendLine(
            'RunHop: Automatically uploaded ' +
              uploaded +
              ' changed file(s) to ' +
              target.config.host
          );
        }
        if (newConflict) {
          warn(
            'RunHop: Remote contents differ on ' +
              target.config.host +
              '. ' +
              conflicts
                .slice(0, 3)
                .map(conflict => conflict.file + ' (' + conflict.kind + ')')
                .join(', ') +
              (conflicts.length > 3 ? ' and ' + (conflicts.length - 3) + ' more' : '') +
              '. Review the changes or use RunHop Upload to replace them.'
          );
        }
        if (errors?.size) {
          warn(
            'RunHop: Automatic upload failed on ' +
              target.config.host +
              '. ' +
              errors.values().next().value
          );
        }
        const unresolved = new Set<string>([
          ...(errors?.keys() ?? []),
          ...conflictFiles,
        ]);
        const observed = observedChanges.get(workspace);
        if (observed) {
          for (const file of files) {
            if (!unresolved.has(file) && observed.get(file) === group.files.get(file)) {
              observed.delete(file);
            }
          }
          if (!observed.size) observedChanges.delete(workspace);
        }
      } catch (error) {
        if (!(error instanceof vscode.CancellationError)) {
          for (const file of files) previous.set(file, error.message);
          warn('RunHop: Automatic upload failed on ' + target.config.host + '. ' + error.message);
        }
      } finally {
        if (previous.size) {
          failures.set(destination, previous);
        } else {
          failures.delete(destination);
        }
        project.dispose();
      }
    });
    return { key, completed };
  }

  async function plan(workspace: string, changed: Map<string, number>): Promise<QueuedUpload[]> {
    const settings = await readOptionalSettings(workspace);
    if (
      !settings?.targets.length ||
      settings.uploadOnSave === false ||
      cancellation.token.isCancellationRequested
    ) {
      return [];
    }
    const groups = new Map<string, Destination>();
    for (const [file, revision] of changed) {
      if (optionsFor(settings, scriptKey(workspace, file)).runOn === 'local') continue;
      const { program, options } = scriptLaunchOptions(
        settings,
        workspace,
        file,
        settings.activeRunConfiguration
      );
      if (
        options.runOn === 'local' ||
        !matchingTargets(settings.targets, workspace, program ?? file).length
      ) {
        continue;
      }
      const interpreter = interpreterFor(
        settings,
        options.interpreter ?? settings.defaultInterpreter
      );
      const target = resolveTarget(
        settings.targets,
        workspace,
        program ?? file,
        interpreter?.target,
        interpreter?.profile
      );
      if (!isLocalPathAtOrUnder(target.service.baseDir, file) || sourceIgnored(target, file, [])) {
        continue;
      }
      const key = projectTransferKey(target);
      const python = interpreter?.path ?? 'python3';
      const policy = uploadPolicyFor(settings, options.uploadPolicy, options.syncPolicy);
      const deleteRemoteOnUpload = settings.deleteRemoteOnUpload === true;
      const id = key + '\0' + target.service.baseDir + '\0' + python + '\0' + policy;
      let group = groups.get(id);
      if (!group) {
        group = {
          key,
          target,
          python,
          policy,
          deleteRemoteOnUpload,
          files: new Map(),
          outputs: new Set(configuredOutputs(settings, target)),
        };
        groups.set(id, group);
      }
      group.files.set(file, revision);
      options.download?.map(artifactPath).forEach(output => group.outputs.add(output));
    }
    return [...groups.values()].map(group => transfer(workspace, group));
  }

  function flush(workspace: string): void {
    const batch = scheduled.get(workspace);
    if (!batch) return;
    clearTimeout(batch.timer);
    scheduled.delete(workspace);
    const entry = {
      workspace,
      uploads: plan(workspace, batch.files).catch(error => {
        warn('RunHop: Could not plan automatic uploads. ' + error.message);
        return [];
      }),
    };
    pending.add(entry);
    void entry.uploads
      .then(jobs => Promise.allSettled(jobs.map(job => job.completed)))
      .finally(() => pending.delete(entry));
  }

  function enqueue(uri: vscode.Uri): void {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || uri.scheme !== 'file') return;
    const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!workspace || uri.fsPath === path.join(workspace, settingsFile)) return;
    const revision = ++nextRevision;
    const observed = observedChanges.get(workspace) ?? new Map<string, number>();
    observed.set(uri.fsPath, revision);
    observedChanges.set(workspace, observed);
    const batch = scheduled.get(workspace) ?? { files: new Map<string, number>(), started: Date.now() };
    batch.files.set(uri.fsPath, revision);
    clearTimeout(batch.timer);
    batch.timer = setTimeout(
      () => flush(workspace),
      Math.max(0, Math.min(quietTime, maxWait - (Date.now() - batch.started)))
    );
    scheduled.set(workspace, batch);
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, true);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(enqueue),
    watcher.onDidChange(enqueue),
    watcher.onDidDelete(enqueue),
    vscode.workspace.onDidSaveTextDocument(document => enqueue(document.uri)),
    {
      dispose() {
        for (const { timer } of scheduled.values()) clearTimeout(timer);
        scheduled.clear();
        observedChanges.clear();
        cancellation.cancel();
        cancellation.dispose();
      },
    }
  );

  return {
    async wait(workspace: string, key: string): Promise<void> {
      const waited = new Set<PendingBatch>();
      for (;;) {
        flush(workspace);
        const entries = [...pending].filter(
          entry => entry.workspace === workspace && !waited.has(entry)
        );
        if (!entries.length) break;
        await Promise.all(
          entries.map(async entry => {
            waited.add(entry);
            const jobs = await entry.uploads;
            await Promise.all(jobs.filter(job => job.key === key).map(job => job.completed));
          })
        );
      }
      const previous = failures.get(failureKey(workspace, key))?.entries().next().value;
      if (previous) {
        const [file, message] = previous;
        throw new Error(
          'Automatic upload failed for ' +
            path.relative(workspace, file) +
            '. ' +
            message +
            ' Retry the edit or use RunHop Upload after reviewing the remote file.'
        );
      }
    },
    clearFailures(workspace: string, key: string, scope?: string): void {
      const destination = failureKey(workspace, key);
      const previous = failures.get(destination);
      if (scope && previous) {
        for (const file of previous.keys()) {
          if (isLocalPathAtOrUnder(scope, file)) previous.delete(file);
        }
        if (previous.size) return;
      }
      failures.delete(destination);
    },
    changedFiles(workspace: string, scope: string): string[] {
      return [...(observedChanges.get(workspace)?.keys() ?? [])].filter(file =>
        isLocalPathAtOrUnder(scope, file)
      );
    },
  };
}
