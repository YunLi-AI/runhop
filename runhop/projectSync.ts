import { mkdir, mkdtemp, realpath, rename, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileType } from './transport/core';
import type { createIncrementalSync, SyncConflict } from './incrementalSync';
import { isLocalPathAtOrUnder } from './paths';
import { artifactPath } from './paths';
import { transferWithRsync } from './rsync';
import {
  isRecord,
  interpreterFor,
  launchSyncMode,
  readOptionalSettings,
  scriptLaunchOptions,
  Settings,
  type SyncPolicy,
  updateSettings,
} from './settings';
import { projectTargets, resolveProjectTarget, RunHopTarget } from './targets';
import {
  downloadProject,
  type ProjectTransfer,
  projectTransfer,
  projectTransferKey,
  projectPathType,
  requireSavedProjectFiles,
  sourceIgnored,
} from './transfers';

async function selectTarget(
  workspace: string,
  folder: string,
  settings: Settings
): Promise<RunHopTarget | undefined> {
  const choices = projectTargets(settings.targets, workspace)
    .filter(
      ({ baseDir }) =>
        isLocalPathAtOrUnder(folder, baseDir) || isLocalPathAtOrUnder(baseDir, folder)
    )
    .flatMap(target => {
      const { raw, baseDir } = target;
      const name = String(raw.name || raw.host || 'SSH target');
      const profiles = isRecord(raw.profiles) ? raw.profiles : {};
      const defaultProfile =
        typeof raw.defaultProfile === 'string' ? raw.defaultProfile : undefined;
      return [
        defaultProfile,
        ...Object.keys(profiles).filter(profile => profile !== defaultProfile),
      ].map(profile => {
        const connection = profile && isRecord(profiles[profile]) ? profiles[profile] : {};
        return {
          label: profile ? name + ' · ' + profile : name,
          description: path.relative(workspace, baseDir) || '.',
          detail:
            String(connection.host || raw.host || '') +
            ' · ' +
            String(connection.remotePath || raw.remotePath || ''),
          target,
          profile,
        };
      });
    });
  if (!choices.length) {
    throw new Error('No RunHop target covers this project folder.');
  }
  const choice =
    choices.length === 1
      ? choices[0]
      : await vscode.window.showQuickPick(choices, {
          title: 'RunHop · Select Project Target',
          ignoreFocusOut: true,
        });
  return choice && resolveProjectTarget(workspace, choice.target, choice.profile);
}

async function setSyncMode(folder: vscode.WorkspaceFolder, settings: Settings): Promise<void> {
  const launchMode = launchSyncMode(settings);
  const onSave = settings.uploadOnSave !== false;
  const current =
    launchMode === 'full' && onSave
      ? 'Sync before launch and upload on save'
      : launchMode === 'full'
        ? 'Sync before launch'
        : launchMode === 'incremental'
          ? 'Sync changed files'
          : onSave
            ? 'Automatic upload'
            : 'Manual only';
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: 'Sync Changed Files',
        detail: 'Upload local edits automatically and verify changes before Run or Debug.',
        syncMode: 'incremental',
        onSave: true,
      },
      {
        label: 'Automatic Upload',
        detail:
          'Upload changed local files as they are written to disk. Skip project scans at launch.',
        syncMode: 'off',
        onSave: true,
      },
      {
        label: 'Sync Project Before Launch',
        detail: 'Compare project files and upload changes on Run or Debug.',
        syncMode: 'full',
        onSave: false,
      },
      {
        label: 'Manual Only',
        detail: 'Use the project upload and download commands when needed.',
        syncMode: 'off',
        onSave: false,
      },
    ],
    {
      title: 'RunHop · Project Sync Mode · ' + folder.name,
      placeHolder: 'Current mode · ' + current,
      ignoreFocusOut: true,
    }
  );
  if (mode) {
    const policy = await vscode.window.showQuickPick(
      [
        { label: 'Safe', description: 'Stop on remote changes', value: 'safe' as SyncPolicy },
        {
          label: 'Force Upload',
          description: 'Replace remote files with local files',
          value: 'force_upload' as SyncPolicy,
        },
        {
          label: 'Force Download',
          description: 'Replace local files with remote files',
          value: 'force_download' as SyncPolicy,
        },
        {
          label: 'Interactive',
          description: 'Choose local or remote for each conflict',
          value: 'interactive' as SyncPolicy,
        },
      ],
      {
        title: 'RunHop · Sync Conflict Policy · ' + folder.name,
        placeHolder: 'Current policy · ' + (settings.uploadPolicy ?? settings.syncPolicy ?? 'safe'),
        ignoreFocusOut: true,
      }
    );
    if (!policy) return;
    await updateSettings(folder, () => [
      { at: ['syncMode'], value: mode.syncMode },
      { at: ['uploadOnSave'], value: mode.onSave },
      { at: ['uploadPolicy'], value: policy.value },
    ]);
    void vscode.window.showInformationMessage(
      'RunHop · ' + folder.name + ' · ' + mode.label + '. Script and launch overrides still apply.'
    );
  }
}

export async function chooseConflict(
  project: ProjectTransfer,
  conflict: SyncConflict
): Promise<'local' | 'remote' | 'baseline' | 'skip'> {
  while (true) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Keep Local', value: 'local' as const, description: 'Upload the local version' },
        { label: 'Keep Remote', value: 'remote' as const, description: 'Download the remote version' },
        { label: 'Open Diff', value: 'diff' as const, description: 'Open local and remote files side by side' },
        {
          label: 'Mark Remote as Baseline',
          value: 'baseline' as const,
          description: 'Keep the local file and accept the remote state as the new baseline',
        },
        { label: 'Skip', value: 'skip' as const, description: 'Leave this file unresolved' },
      ],
      {
        title: 'RunHop · Resolve Sync Conflict · ' + conflict.file,
        placeHolder:
          conflict.kind +
          ' · local ' +
          (conflict.localFingerprint ?? 'missing') +
          ' · remote ' +
          (conflict.remoteFingerprint ?? 'missing') +
          ' · last local ' +
          (conflict.baselineLocalFingerprint ?? 'missing') +
          ' · last remote ' +
          (conflict.baselineRemoteFingerprint ?? 'missing') +
          ' · local sha ' +
          (conflict.localSha256 ?? 'missing') +
          ' · remote sha ' +
          (conflict.remoteSha256 ?? 'missing') +
          ' · baseline sha ' +
          (conflict.baselineSha256 ?? 'missing'),
        ignoreFocusOut: true,
      }
    );
    if (!choice || choice.value !== 'diff') return choice?.value ?? 'skip';
    try {
      const destination = await mkdtemp(path.join(tmpdir(), 'runhop-conflict-'));
      const localFile = path.join(project.service.baseDir, ...conflict.file.split('/'));
      await downloadProject(project, destination, localFile);
      const remoteFile = path.join(destination, ...conflict.file.split('/'));
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(localFile),
        vscode.Uri.file(remoteFile),
        'RunHop · ' + conflict.file
      );
    } catch (error) {
      void vscode.window.showWarningMessage('RunHop: Could not open the conflict diff. ' + error.message);
    }
  }
}

function syncPython(settings: Settings, workspace: string, file: string): string {
  const { options } = scriptLaunchOptions(settings, workspace, file, settings.activeRunConfiguration);
  return (
    interpreterFor(settings, options.interpreter ?? settings.defaultInterpreter)?.path ?? 'python3'
  );
}

export function configuredOutputs(settings: Settings, target: RunHopTarget): string[] {
  const { workspace, baseDir } = target.service;
  const entries = [
    ...Object.entries(settings.scripts ?? {}),
    ...Object.values(settings.runConfigurations ?? {})
      .filter(preset => typeof preset?.program === 'string')
      .map(preset => [preset.program, preset] as const),
  ];
  return entries.flatMap(([file, options]) =>
    isLocalPathAtOrUnder(baseDir, path.resolve(workspace, file)) && Array.isArray(options?.download)
      ? options.download.map(artifactPath)
      : []
  );
}

export function registerProjectSync(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  queueTransfer: (key: string, transfer: () => Promise<void>) => Promise<void>,
  excludeOutputs: (key: string, outputs: string[]) => string[],
  clearFailures: (workspace: string, key: string, scope?: string) => void,
  incremental: ReturnType<typeof createIncrementalSync>
): void {
  for (const action of ['upload', 'download', 'syncMode', 'refreshBaseline', 'settings'] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand('runhop.project.' + action, async (resource?: vscode.Uri) => {
        try {
          const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
          const folders = vscode.workspace.workspaceFolders ?? [];
          const folder = uri
            ? vscode.workspace.getWorkspaceFolder(uri)
            : folders.length === 1
              ? folders[0]
              : await vscode.window.showWorkspaceFolderPick();
          if (
            folder?.uri.scheme !== 'file' ||
            !vscode.workspace.isTrusted ||
            vscode.env.remoteName
          ) {
            throw new Error('RunHop requires a trusted local project folder.');
          }
          if (action === 'settings') {
            await vscode.commands.executeCommand('runhop.configurations', folder, {
              section: 'sync',
            });
            return;
          }
          const workspace = folder.uri.fsPath;
          log.appendLine('Project ' + action + ' · ' + (uri?.fsPath ?? workspace));
          const settings = (await readOptionalSettings(workspace)) ?? { targets: [] };
          if (action === 'syncMode') {
            await setSyncMode(folder, settings);
            return;
          }
          if (!settings.targets.length) {
            await vscode.commands.executeCommand('runhop.configurations', folder, {
              section: 'servers',
            });
            return;
          }
          const target = await selectTarget(workspace, resource?.fsPath ?? workspace, settings);
          if (!target) {
            return;
          }
          const scope =
            resource && isLocalPathAtOrUnder(target.service.baseDir, resource.fsPath)
              ? resource.fsPath
              : target.service.baseDir;
          const relative = path.relative(target.service.baseDir, scope).split(path.sep).join('/');
          if (action === 'refreshBaseline') {
            const fileStat = await stat(scope).catch(() => undefined);
            const fileScope =
              fileStat?.isFile() ||
              (!fileStat && Boolean(resource) && path.extname(scope).length > 0);
            const key = projectTransferKey(target);
            await queueTransfer(key, async () => {
              const project = projectTransfer(target);
              const cancellation = new vscode.CancellationTokenSource();
              try {
                const result = await incremental.sync(
                  project,
                  excludeOutputs(key, configuredOutputs(settings, target)),
                  syncPython(settings, workspace, scope),
                  cancellation.token,
                  message => log.appendLine('RunHop: ' + message),
                  fileScope ? [scope] : undefined,
                  {
                    policy: 'safe',
                    refreshOnly: true,
                    scope: fileScope ? undefined : scope,
                  }
                );
                clearFailures(workspace, key, fileScope ? scope : undefined);
                if (result.conflicts.length) {
                  void vscode.window.showWarningMessage(
                    'RunHop: Baseline refreshed with unresolved conflicts. ' +
                      result.conflicts.map(conflict => conflict.file).join(', ')
                  );
                } else {
                  void vscode.window.showInformationMessage(
                    'RunHop: Sync baseline refreshed on ' + target.config.host + '.'
                  );
                }
              } finally {
                cancellation.dispose();
                project.dispose();
              }
            });
            return;
          }
          const choices =
            action === 'upload'
              ? [
                  {
                    label: 'SFTP · Safe Upload',
                    description: 'Stop when the remote file changed',
                    protocol: 'sftp' as const,
                    policy: 'safe' as SyncPolicy,
                  },
                  {
                    label: 'SFTP · Force Upload',
                    description: 'Replace the remote version with local files',
                    protocol: 'sftp' as const,
                    policy: 'force_upload' as SyncPolicy,
                  },
                  {
                    label: 'SFTP · Interactive',
                    description: 'Choose local or remote for every conflict',
                    protocol: 'sftp' as const,
                    policy: 'interactive' as SyncPolicy,
                  },
                  {
                    label: 'rsync · Force Upload',
                    description: 'Mirror local files to the remote project',
                    protocol: 'rsync' as const,
                    policy: 'force_upload' as SyncPolicy,
                  },
                ]
              : [
                  {
                    label: 'SFTP · Snapshot Download',
                    description: 'Download into a reviewable local snapshot',
                    protocol: 'sftp' as const,
                    policy: undefined,
                  },
                  {
                    label: 'rsync · Snapshot Download',
                    description: 'Download into a reviewable local snapshot',
                    protocol: 'rsync' as const,
                    policy: undefined,
                  },
                  {
                    label: 'SFTP · Force Download',
                    description: 'Replace local files with the remote version',
                    protocol: 'sftp' as const,
                    policy: 'force_download' as SyncPolicy,
                  },
                  {
                    label: 'rsync · Force Download',
                    description: 'Replace local files with the remote version',
                    protocol: 'rsync' as const,
                    policy: 'force_download' as SyncPolicy,
                  },
                ];
          const method = await vscode.window.showQuickPick(choices,
            {
              title:
                'RunHop · ' +
                (action === 'upload' ? 'Upload' : 'Download') +
                ' · ' +
                (relative || '.'),
              placeHolder:
                target.config.host + ' · ' + path.posix.join(target.config.remotePath, relative),
              ignoreFocusOut: true,
            }
          );
          if (!method) {
            return;
          }
          const key = projectTransferKey(target);
          await queueTransfer(key, async () => {
            const project = projectTransfer(target);
            try {
              if (action === 'upload') {
                const base = await realpath(target.service.baseDir);
                if (!isLocalPathAtOrUnder(await realpath(workspace), base)) {
                  throw new Error('The upload directory must be inside the local workspace.');
                }
                const outputs = excludeOutputs(key, configuredOutputs(settings, target));
                const kind = await projectPathType(
                  target.service.getLocalFileSystem(),
                  base,
                  relative
                );
                if (
                  sourceIgnored(target, scope, outputs) ||
                  (kind === FileType.Directory && target.ignoreDirectory(scope))
                ) {
                  throw new Error('The selected path is excluded by the project ignore rules.');
                }
                requireSavedProjectFiles(target, outputs, scope);
                if (method.policy === 'force_upload') {
                  const choice = await vscode.window.showWarningMessage(
                    'RunHop will replace remote files under ' +
                      (relative || '.') +
                      ' with the local version.',
                    { modal: true },
                    'Force Upload'
                  );
                  if (choice !== 'Force Upload') return;
                }
                const python = syncPython(settings, workspace, scope);
                const cancellation = new vscode.CancellationTokenSource();
                const upload = async () => {
                  if (method.protocol === 'rsync') {
                    await transferWithRsync(target, scope, 'upload', '', outputs);
                  }
                  const result = await incremental.sync(
                    project,
                    outputs,
                    python,
                    cancellation.token,
                    message => log.appendLine('RunHop: ' + message),
                    kind === FileType.File ? [scope] : undefined,
                    {
                      policy: method.policy,
                      scope: kind === FileType.Directory ? scope : undefined,
                      resolveConflict:
                        (method.policy === 'safe' || method.policy === 'interactive')
                          ? conflict => chooseConflict(project, conflict)
                          : undefined,
                    }
                  );
                  if (result.conflicts.length) {
                    throw new Error(
                      'Unresolved conflicts: ' +
                        result.conflicts.map(conflict => conflict.file).join(', ')
                    );
                  }
                };
                try {
                  await upload();
                } finally {
                  cancellation.dispose();
                }
                clearFailures(workspace, key, relative ? scope : undefined);
                void vscode.window.showInformationMessage(
                  'RunHop: Upload finished on ' + target.config.host + '.'
                );
              } else {
                const force = method.policy === 'force_download';
                if (force) {
                  const choice = await vscode.window.showWarningMessage(
                    'RunHop will replace local files under ' +
                      (relative || '.') +
                      ' with the remote version.',
                    { modal: true },
                    'Force Download'
                  );
                  if (choice !== 'Force Download') return;
                }
                const parent = force
                  ? tmpdir()
                  : path.join(workspace, '.vscode', 'runhop-downloads');
                if (!force) await mkdir(parent, { recursive: true });
                const destination = await mkdtemp(path.join(parent, 'runhop-project-'));
                try {
                  if (method.protocol === 'rsync') {
                    await transferWithRsync(target, scope, 'download', destination, []);
                  } else {
                    await downloadProject(project, destination, scope);
                  }
                  if (force) {
                    const source = path.join(destination, ...relative.split('/'));
                    const downloadedDirectory = (await stat(source)).isDirectory();
                    await rm(scope, { recursive: true, force: true });
                    await rename(source, scope);
                    const python = syncPython(settings, workspace, scope);
                    const cancellation = new vscode.CancellationTokenSource();
                    try {
                      await incremental.sync(
                        project,
                        excludeOutputs(key, configuredOutputs(settings, target)),
                        python,
                        cancellation.token,
                        message => log.appendLine('RunHop: ' + message),
                        downloadedDirectory ? undefined : [scope],
                        { policy: 'safe', scope: downloadedDirectory ? scope : undefined }
                      );
                    } finally {
                      cancellation.dispose();
                    }
                  }
                } catch (error) {
                  await rm(destination, { recursive: true, force: true }).catch(cleanupError =>
                    log.appendLine(
                      'Could not remove incomplete snapshot ' +
                        destination +
                        '. ' +
                        cleanupError.message
                    )
                  );
                  throw error;
                }
                log.appendLine('Project snapshot: ' + destination);
                void vscode.window
                  .showInformationMessage(
                    'RunHop: Saved project snapshot to ' + destination,
                    'Reveal Snapshot'
                  )
                  .then(choice => {
                    if (choice) {
                      return vscode.commands.executeCommand(
                        'revealFileInOS',
                        vscode.Uri.file(destination)
                      );
                    }
                  });
              }
            } finally {
              project.dispose();
            }
          });
        } catch (error) {
          if (!(error instanceof vscode.CancellationError)) {
            log.appendLine('Project ' + action + ' failed. ' + error.message);
            void vscode.window.showErrorMessage('RunHop: ' + error.message);
          }
        }
      })
    );
  }
}
