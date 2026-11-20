import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileType } from './transport/core';
import { isLocalPathAtOrUnder } from './paths';
import { artifactPath } from './paths';
import { transferWithRsync } from './rsync';
import {
  isRecord,
  launchSyncMode,
  readOptionalSettings,
  Settings,
  updateSettings,
} from './settings';
import { projectTargets, resolveProjectTarget, RunHopTarget } from './targets';
import {
  downloadProject,
  projectTransfer,
  projectTransferKey,
  projectPathType,
  requireSavedProjectFiles,
  syncSource,
  sourceIgnored,
  uploadSavedFile,
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
            ? 'Upload on save'
            : 'Manual only';
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: 'Sync Changed Files',
        detail: 'Deploy once, then upload saves and send local changes before Run or Debug.',
        syncMode: 'incremental',
        onSave: true,
      },
      {
        label: 'Upload on Save',
        detail: 'Upload only the saved file. Skip project scans at launch.',
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
    await updateSettings(folder, () => [
      { at: ['syncMode'], value: mode.syncMode },
      { at: ['uploadOnSave'], value: mode.onSave },
    ]);
    void vscode.window.showInformationMessage(
      'RunHop · ' + folder.name + ' · ' + mode.label + '. Script and launch overrides still apply.'
    );
  }
}

function configuredOutputs(settings: Settings, target: RunHopTarget): string[] {
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
  clearFailures: (workspace: string, key: string) => void
): void {
  for (const action of ['upload', 'download', 'syncMode', 'settings'] as const) {
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
          const method = await vscode.window.showQuickPick(
            [
              { label: 'SFTP', description: 'Use RunHop’s built-in transfer' },
              { label: 'rsync', description: 'Use rsync on this computer and the server' },
            ],
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
                const upload = async () => {
                  if (method.label === 'rsync') {
                    await transferWithRsync(target, scope, 'upload', '', outputs);
                  } else if (kind === FileType.File) {
                    if (!(await uploadSavedFile(project, scope, undefined, true))) {
                      throw new Error('The selected file is no longer available to upload.');
                    }
                  } else {
                    await syncSource(project, outputs, { scope });
                  }
                };
                await upload();
                if (!relative) {
                  clearFailures(workspace, key);
                }
                void vscode.window.showInformationMessage(
                  'RunHop: Upload finished on ' + target.config.host + '.'
                );
              } else {
                const parent = path.join(workspace, '.vscode', 'runhop-downloads');
                await mkdir(parent, { recursive: true });
                const destination = await mkdtemp(path.join(parent, 'project-'));
                try {
                  if (method.label === 'rsync') {
                    await transferWithRsync(target, scope, 'download', destination, []);
                  } else {
                    await downloadProject(project, destination, scope);
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
