import * as path from 'path';
import * as vscode from 'vscode';
import { isLocalPathAtOrUnder } from './paths';
import { IncrementalSync, sourceFingerprint } from './incrementalSync';
import { artifactPath } from './paths';
import {
  interpreterFor,
  optionsFor,
  readSettings,
  scriptKey,
  scriptLaunchOptions,
  settingsFile,
} from './settings';
import { matchingTargets, resolveTarget } from './targets';
import { projectTransfer, projectTransferKey, sourceIgnored, uploadSavedFile } from './transfers';

type QueuedUpload = { key: string; completed: Promise<void> };

export function registerSaveUploads(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  queueTransfer: (key: string, transfer: () => Promise<void>) => Promise<void>,
  excludeOutputs: (key: string, outputs: string[]) => string[],
  incremental: IncrementalSync
) {
  const pending = new Set<{ workspace: string; upload: Promise<QueuedUpload | undefined> }>();
  const failures = new Map<string, Map<string, string>>();
  const cancellation = new vscode.CancellationTokenSource();
  const failureKey = (workspace: string, key: string) => workspace + '\0' + key;

  async function plan(workspace: string, file: string): Promise<QueuedUpload | undefined> {
    const settings = await readSettings(workspace).catch(error => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    if (
      !settings ||
      !settings.targets.length ||
      settings.uploadOnSave === false ||
      cancellation.token.isCancellationRequested
    ) {
      return;
    }
    if (optionsFor(settings, scriptKey(workspace, file)).runOn === 'local') {
      return;
    }
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
      return;
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
    const outputs = (options.download ?? []).map(artifactPath);
    const key = projectTransferKey(target);
    if (
      !isLocalPathAtOrUnder(target.service.baseDir, file) ||
      sourceIgnored(target, file, outputs)
    ) {
      return;
    }
    const completed = queueTransfer(key, async () => {
      if (
        cancellation.token.isCancellationRequested ||
        sourceIgnored(target, file, excludeOutputs(key, outputs))
      ) {
        return;
      }
      const project = projectTransfer(target);
      const destination = failureKey(workspace, key);
      try {
        const fingerprint = await sourceFingerprint(file);
        if (await uploadSavedFile(project, file, cancellation.token)) {
          if (fingerprint !== undefined) {
            await incremental.rememberUpload(target, file, fingerprint);
          }
          log.appendLine(
            'Uploaded ' + path.relative(workspace, file) + ' to ' + target.config.host
          );
        }
        const previous = failures.get(destination);
        previous?.delete(file);
        if (!previous?.size) {
          failures.delete(destination);
        }
      } catch (error) {
        if (!(error instanceof vscode.CancellationError)) {
          const failed = failures.get(destination) ?? new Map<string, string>();
          failed.set(file, error.message);
          failures.set(destination, failed);
        }
        throw error;
      } finally {
        project.dispose();
      }
    });
    return { key, completed };
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName || document.uri.scheme !== 'file') {
        return;
      }
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const file = document.uri.fsPath;
      if (!workspace || file === path.join(workspace, settingsFile)) {
        return;
      }
      const entry = { workspace, upload: plan(workspace, file) };
      pending.add(entry);
      void entry.upload
        .then(job => job?.completed)
        .catch(error => {
          if (
            !cancellation.token.isCancellationRequested &&
            !(error instanceof vscode.CancellationError)
          ) {
            const message =
              'RunHop: Save upload failed for ' +
              path.relative(workspace, file) +
              '. ' +
              error.message;
            log.appendLine(message);
            void vscode.window.showWarningMessage(message);
          }
        })
        .finally(() => pending.delete(entry));
    }),
    {
      dispose() {
        cancellation.cancel();
        cancellation.dispose();
      },
    }
  );

  return {
    async wait(workspace: string, key: string): Promise<void> {
      await Promise.all(
        [...pending]
          .filter(entry => entry.workspace === workspace)
          .map(async entry => {
            const job = await entry.upload.catch(() => undefined);
            if (job?.key === key) {
              await job.completed.catch(() => undefined);
            }
          })
      );
      const previous = failures.get(failureKey(workspace, key))?.entries().next().value;
      if (previous) {
        const [file, message] = previous;
        throw new Error(
          'Save upload failed for ' +
            path.relative(workspace, file) +
            '. Save the file again or enable Sync Before Launch. ' +
            message
        );
      }
    },
    clearFailures(workspace: string, key: string): void {
      failures.delete(failureKey(workspace, key));
    },
  };
}
