import { mkdir, mkdtemp, realpath, stat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isLocalPathAtOrUnder } from './paths';
import { AdapterLaunch, PythonAdapter, SessionAdapter } from './adapter';
import { registerControls } from './controls';
import type { ConfigurationEditorProject } from './configurationsPanel';
import { prepareLocalDebugger, resolveRemotePath, startRemoteDebugger } from './debuggerHelper';
import { DirectRun } from './directRun';
import { registerFileLaunch } from './fileLaunch';
import { createIncrementalSync } from './incrementalSync';
import { localLaunchKey, resolveLocalPython } from './localPython';
import { artifactPath, mapProjectPath } from './paths';
import { registerProjectSync } from './projectSync';
import { registerSaveUploads } from './saveUploads';
import {
  ProjectTransfer,
  projectTransfer,
  projectTransferKey,
  downloadResults,
  requireSavedProjectFiles,
  sourceIgnored,
  syncSource,
} from './transfers';
import { connectSsh, resolveTarget } from './targets';
import { SessionTerminal, TerminalPanel } from './terminal';
import {
  configuredScript,
  isRemotePython,
  isSyncMode,
  launchSyncMode,
  readSettings,
  settingsFile,
  validateLaunchArguments,
} from './settings';
import { Execution, Outcome, rerunTokenKey } from './sessionState';

export const debugType = 'runhop-python';

interface RemoteLaunch extends ProjectTransfer {
  localRoot: string;
  program?: string;
  cwd: string;
  remotePython: string;
  outputs: string[];
  syncMode: ReturnType<typeof launchSyncMode>;
  uploadOnSave: boolean;
  launch: vscode.DebugConfiguration;
}

async function resolveLaunch(session: vscode.DebugSession): Promise<RemoteLaunch> {
  const requested = session.configuration;
  const folder = session.workspaceFolder;
  if (!vscode.workspace.isTrusted || folder?.uri.scheme !== 'file' || vscode.env.remoteName) {
    throw new Error('RunHop requires a trusted local workspace.');
  }
  const root = folder.uri;
  const settings = await readSettings(root.fsPath);
  if (requested.runConfiguration !== undefined && typeof requested.runConfiguration !== 'string') {
    throw new Error('runConfiguration must name a saved RunHop configuration.');
  }
  if (
    requested.syncBeforeLaunch !== undefined ||
    (requested.syncMode !== undefined && !isSyncMode(requested.syncMode))
  ) {
    throw new Error(
      'Set syncMode to "incremental", "full" or "off" in the RunHop launch configuration.'
    );
  }
  if (requested.program !== undefined && typeof requested.program !== 'string') {
    throw new Error('program must be a local Python file.');
  }
  if (requested.runConfiguration !== undefined && (requested.program || requested.module)) {
    throw new Error('A named RunHop configuration already selects the Python program.');
  }
  const file = requested.program ? path.resolve(root.fsPath, requested.program) : undefined;
  const { program, module, options, interpreter } = configuredScript(
    settings,
    root.fsPath,
    file,
    requested.runConfiguration
  );
  if (options.runOn === 'local') {
    throw new Error('This RunHop configuration runs locally. Use RunHop: Run or RunHop: Debug.');
  }
  if (
    typeof requested.runhopSelectedFile === 'string' &&
    (!program || path.relative(requested.runhopSelectedFile, program) !== '')
  ) {
    throw new Error('The saved RunHop configuration no longer points to the selected file.');
  }
  const launch: vscode.DebugConfiguration = {
    ...options,
    target: interpreter?.target,
    profile: interpreter?.profile,
    remotePython: interpreter?.path,
    module,
    ...requested,
    program,
  };
  const syncMode = launchSyncMode(settings, launch.syncMode);
  const cwd = launch.cwd ? path.resolve(root.fsPath, launch.cwd) : undefined;
  if (Boolean(program) === Boolean(launch.module)) {
    throw new Error('Specify either a local Python program or a module name.');
  }
  const target = resolveTarget(
    settings.targets,
    root.fsPath,
    program || cwd || root.fsPath,
    launch.target,
    launch.profile
  );
  const { service, config } = target;
  const remotePython = launch.remotePython || 'python3';
  if (!isRemotePython(remotePython)) {
    throw new Error('remotePython must be an absolute path or an executable name on the server.');
  }
  if (
    launch.download !== undefined &&
    (!Array.isArray(launch.download) || launch.download.some(item => typeof item !== 'string'))
  ) {
    throw new Error('download must be a list of remote paths within the project.');
  }
  validateLaunchArguments(launch.args, launch.env);
  if (
    launch.module !== undefined &&
    (typeof launch.module !== 'string' || launch.module.includes('\0'))
  ) {
    throw new Error('module must be a Python module name.');
  }
  const outputs = [...new Set<string>((launch.download || []).map(artifactPath))];
  const workingDirectory = cwd || service.baseDir;
  const canonicalRoot = await realpath(service.baseDir);
  for (const local of [workingDirectory, ...(program ? [program] : [])]) {
    if (
      !isLocalPathAtOrUnder(service.baseDir, local) ||
      !isLocalPathAtOrUnder(canonicalRoot, await realpath(local))
    ) {
      throw new Error('The program and working directory must be inside the SFTP project.');
    }
  }
  if (!(await stat(workingDirectory)).isDirectory()) {
    throw new Error('The configured working directory must be a directory.');
  }
  if (program && !(await stat(program)).isFile()) {
    throw new Error('The Python program must be a file.');
  }
  if (syncMode !== 'off') {
    if (program && sourceIgnored({ service, config }, program, outputs)) {
      throw new Error('The Python program must be included in the source sync.');
    }
  }
  requireSavedProjectFiles(target, outputs);
  return {
    ...projectTransfer(target),
    program,
    cwd: workingDirectory,
    localRoot: service.baseDir,
    remotePython,
    outputs,
    syncMode,
    uploadOnSave: settings.uploadOnSave !== false,
    launch,
  };
}

interface ActiveRun {
  cancellation: vscode.CancellationTokenSource;
  adapter?: SessionAdapter;
  project?: RemoteLaunch;
  key?: string;
}

export function replay(
  folder: vscode.WorkspaceFolder | undefined,
  launch: vscode.DebugConfiguration,
  noDebug = false
): NonNullable<Execution['rerun']> {
  return async token => {
    const started = await vscode.debug.startDebugging(
      folder,
      { ...launch, [rerunTokenKey]: token },
      { noDebug, suppressDebugView: true, suppressSaveBeforeStart: true }
    );
    if (!started) {
      throw new Error('VS Code could not restart this RunHop session.');
    }
  };
}

export function registerLaunch(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  panel: TerminalPanel,
  activeConfigurationProject: () => ConfigurationEditorProject | undefined
): void {
  const active = new Map<string, ActiveRun>();
  const transfers = new Map<string, Promise<void>>();

  function queueTransfer<T>(key: string, transfer: () => Promise<T>): Promise<T> {
    const task = (transfers.get(key) ?? Promise.resolve()).then(transfer);
    const tail = task.then(
      () => {},
      () => {}
    );
    transfers.set(key, tail);
    void tail.then(() => {
      if (transfers.get(key) === tail) {
        transfers.delete(key);
      }
    });
    return task;
  }

  function excludeOutputs(key: string, outputs: string[]): string[] {
    const exclusions = new Set(outputs);
    for (const run of active.values()) {
      if (run.key === key && run.project) {
        run.project.outputs.forEach(output => exclusions.add(output));
      }
    }
    return [...exclusions];
  }

  async function collectResults(
    project: RemoteLaunch,
    key: string,
    outcome: Outcome,
    terminal: SessionTerminal
  ): Promise<void> {
    try {
      if (outcome.code !== undefined && project.outputs.length) {
        terminal.showActivity('Waiting to download results from ' + project.config.host + '…');
        await queueTransfer(key, async () => {
          const results = path.join(project.localRoot, '.vscode', 'runhop-results');
          await mkdir(results, { recursive: true });
          const destination = await mkdtemp(path.join(results, 'run-'));
          await downloadResults(project, project.outputs, destination, message =>
            terminal.showActivity(message)
          );
          log.appendLine('Results directory: ' + destination);
        });
      }
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) {
        log.appendLine(String(error));
        void vscode.window.showWarningMessage(
          'RunHop: Could not download results. ' + error.message
        );
      }
    } finally {
      terminal.showActivity();
      project.dispose();
    }
  }

  const incremental = createIncrementalSync(context.storageUri ?? context.globalStorageUri);
  const uploads = registerSaveUploads(context, log, queueTransfer, excludeOutputs);
  registerProjectSync(context, log, queueTransfer, excludeOutputs, uploads.clearFailures);
  registerControls(context, log, debugType, panel, activeConfigurationProject);
  registerFileLaunch(context, debugType);
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      const run = active.get(session.id);
      run?.cancellation.cancel();
      run?.adapter?.dispose();
    }),
    {
      dispose() {
        for (const run of active.values()) {
          run.cancellation.cancel();
          run.adapter?.dispose();
        }
      },
    },
    vscode.debug.registerDebugConfigurationProvider(debugType, {
      resolveDebugConfiguration(_folder, configuration) {
        if (configuration.type === debugType) {
          configuration.internalConsoleOptions ??= 'neverOpen';
        }
        return configuration;
      },
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory(debugType, {
      async createDebugAdapterDescriptor(session) {
        const run: ActiveRun = { cancellation: new vscode.CancellationTokenSource() };
        active.set(session.id, run);
        const direct = session.configuration.noDebug === true;
        const name = (direct ? 'Run · ' : 'Debug · ') + session.name;
        const execution: Execution = {
          id: session.id,
          workspace: session.workspaceFolder?.uri.toString(),
          configurationFile: settingsFile,
          rerun: replay(session.workspaceFolder, session.configuration, direct),
          async stop() {
            if (run.adapter) {
              await vscode.debug.stopDebugging(session);
            } else {
              run.cancellation.cancel();
            }
          },
        };
        const terminal = panel.create(
          name,
          false,
          direct ? undefined : session.id,
          execution,
          session.configuration[rerunTokenKey]
        );
        const checkCancelled = () => {
          if (run.cancellation.token.isCancellationRequested) {
            throw new vscode.CancellationError();
          }
        };
        const bindAdapter = (adapter: SessionAdapter) => {
          if (run.cancellation.token.isCancellationRequested) {
            adapter.dispose();
            throw new vscode.CancellationError();
          }
          run.adapter = adapter;
          void adapter.completion.then(outcome => {
            active.delete(session.id);
            run.cancellation.dispose();
            adapter.dispose();
            if (run.project && run.key) {
              return collectResults(run.project, run.key, outcome, terminal);
            }
          });
          return new vscode.DebugAdapterInlineImplementation(adapter);
        };
        try {
          const bundle = context.asAbsolutePath('resources/debugpy.whl');
          if (session.configuration[localLaunchKey] === true) {
            terminal.showActivity('Selecting local Python…');
            const plan = await resolveLocalPython(session, !direct);
            checkCancelled();
            Object.assign(execution, {
              python: plan.python,
              cwd: plan.cwd,
              program: plan.program ?? plan.module,
            });
            log.appendLine('Starting ' + name);
            if (direct) return bindAdapter(new DirectRun(undefined, plan, terminal, log));
            const helper = await prepareLocalDebugger(
              context.globalStorageUri.fsPath,
              plan.python,
              plan.cwd,
              bundle,
              () => terminal.showActivity('Preparing the local debugger…')
            );
            checkCancelled();
            return bindAdapter(PythonAdapter.startLocal(plan, helper, terminal, log));
          }
          const project = (run.project = await resolveLaunch(session));
          const { service, config, localRoot, remotePython, outputs, launch } = project;
          const key = (run.key = projectTransferKey(project));
          const workspace = session.workspaceFolder!.uri.fsPath;
          checkCancelled();
          Object.assign(execution, {
            host: config.host,
            python: remotePython,
            program: project.program ?? launch.module,
          });
          if (project.syncMode === 'full') {
            terminal.showActivity('Waiting to sync project files to ' + config.host + '…');
            await queueTransfer(key, async () => {
              checkCancelled();
              await syncSource(project, excludeOutputs(key, outputs), {
                cancellation: run.cancellation.token,
                onStatus: message => terminal.showActivity(message),
              });
              uploads.clearFailures(workspace, key);
            });
          } else {
            if (project.uploadOnSave) {
              await uploads.wait(workspace, key);
            }
            if (project.syncMode === 'incremental') {
              await queueTransfer(key, async () => {
                checkCancelled();
                const { uploaded, restored } = await incremental.sync(
                  project,
                  excludeOutputs(key, outputs),
                  remotePython,
                  run.cancellation.token,
                  message => terminal.showActivity(message)
                );
                if (restored) {
                  terminal.write(
                    '[RunHop] Restored ' +
                      restored +
                      ' missing remote file(s) from saved local source.\n'
                  );
                }
                if (uploaded) {
                  log.appendLine(
                    'RunHop: Uploaded ' + uploaded + ' changed project file(s) to ' + config.host
                  );
                }
              });
            }
          }
          checkCancelled();
          terminal.showActivity('Connecting to remote Python on ' + config.host + '…');
          const { fs, client } = await connectSsh(service, config);
          const remoteRoot = await resolveRemotePath(client, config.remotePath);
          requireSavedProjectFiles(project, excludeOutputs(key, outputs));
          const args: AdapterLaunch = {
            python: remotePython,
            cwd: mapProjectPath(project.cwd, localRoot, remoteRoot),
            ...(project.program
              ? { program: mapProjectPath(project.program, localRoot, remoteRoot) }
              : { module: launch.module }),
            args: launch.args || [],
            env: launch.env || {},
            pathMapping: { localRoot, remoteRoot },
            justMyCode: launch.justMyCode !== false,
            stopOnEntry: launch.stopOnEntry === true,
          };
          execution.cwd = args.cwd;
          checkCancelled();
          const raw = client.getRawClient();
          log.appendLine('Starting ' + name + ' on ' + config.host);
          let adapter: SessionAdapter;
          if (direct) {
            adapter = new DirectRun(raw, args, terminal, log);
          } else {
            const channel = await startRemoteDebugger(
              fs,
              client,
              remotePython,
              bundle,
              () => terminal.showActivity('Preparing the debugger on ' + config.host + '…'),
              checkCancelled
            );
            adapter = PythonAdapter.startRemote(channel, args, terminal, log);
          }
          return bindAdapter(adapter);
        } catch (error) {
          const cancelled = error instanceof vscode.CancellationError;
          const detail = cancelled ? 'Launch cancelled.' : error.message;
          terminal.write('[RunHop] ' + detail + '\n');
          if (!cancelled) log.appendLine('RunHop: ' + detail);
          terminal.finish({ phase: cancelled ? 'Exited' : 'Failed', detail });
          active.delete(session.id);
          run.cancellation.dispose();
          run.project?.dispose();
          throw error;
        }
      },
    })
  );
}
