import * as path from 'node:path';
import * as vscode from 'vscode';
import { promptToConfigureRun } from './runConfigurations';
import { readOptionalSettings, scriptKey, scriptLaunchOptions, Settings } from './settings';
import { matchingTargets } from './targets';

export function presetsForFile(settings: Settings, workspace: string, file: string): string[] {
  const key = scriptKey(workspace, file);
  const matches = Object.entries(settings.runConfigurations ?? {})
    .filter(
      ([, preset]) =>
        typeof preset?.program === 'string' &&
        scriptKey(workspace, path.resolve(workspace, preset.program)) === key
    )
    .map(([name]) => name);
  const active = settings.activeRunConfiguration;
  return active && matches.includes(active) ? [active] : matches;
}

export function fileRunsRemotely(
  settings: Settings | undefined,
  workspace: string,
  file: string | undefined,
  preset?: string
): boolean {
  if (!settings) return false;
  const { options, program } = scriptLaunchOptions(settings, workspace, file, preset);
  const location = program ?? (options.cwd ? path.resolve(workspace, options.cwd) : workspace);
  if (options.runOn) return options.runOn === 'remote';
  return (
    Boolean(options.interpreter) ||
    matchingTargets(settings.targets, workspace, location).length > 0
  );
}

export async function startLocalPython(
  folder: vscode.WorkspaceFolder,
  file: string | undefined,
  noDebug: boolean,
  settings: Settings,
  preset?: string
): Promise<boolean> {
  if (!vscode.extensions.getExtension('ms-python.debugpy')) {
    throw new Error(
      'Enable the Python Debugger extension (ms-python.debugpy) to run Python locally.'
    );
  }
  const { program, module, options } = scriptLaunchOptions(
    settings,
    folder.uri.fsPath,
    file,
    preset
  );
  if (!program && !module) throw new Error('Select a Python script or module to run.');
  const config: vscode.DebugConfiguration = {
    type: 'debugpy',
    request: 'launch',
    name: 'Local · ' + (preset || module || path.basename(program!)),
    ...(program ? { program } : { module }),
    cwd: options.cwd ? path.resolve(folder.uri.fsPath, options.cwd) : folder.uri.fsPath,
    args: options.args ?? [],
    env: options.env ?? {},
    justMyCode: options.justMyCode ?? true,
    stopOnEntry: !noDebug && options.stopOnEntry === true,
    console: noDebug ? 'integratedTerminal' : 'internalConsole',
    internalConsoleOptions: 'neverOpen',
    runhopUsesProjectSettings: true,
  };
  return vscode.debug.startDebugging(folder, config, { noDebug, suppressDebugView: true });
}

export function registerFileLaunch(context: vscode.ExtensionContext, debugType: string): void {
  for (const [command, noDebug] of [
    ['runhop.file.run', true],
    ['runhop.file.debug', false],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (resource?: vscode.Uri) => {
        try {
          const uri =
            resource instanceof vscode.Uri
              ? resource
              : vscode.window.activeTextEditor?.document.uri;
          const folder =
            uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
          if (
            !folder ||
            !uri ||
            !vscode.workspace.isTrusted ||
            vscode.env.remoteName ||
            !/\.pyw?$/i.test(uri.fsPath)
          ) {
            throw new Error('Select a Python file in a trusted local workspace.');
          }
          const workspace = folder.uri.fsPath;
          const settings = await readOptionalSettings(workspace);
          if (!settings) {
            await promptToConfigureRun(folder, uri);
            return;
          }
          const presets = presetsForFile(settings, workspace, uri.fsPath);
          const preset =
            presets.length > 1
              ? await vscode.window.showQuickPick(presets, {
                  title: 'RunHop · ' + path.basename(uri.fsPath),
                })
              : presets[0];
          if (presets.length > 1 && preset === undefined) return;
          if (!fileRunsRemotely(settings, workspace, uri.fsPath, preset)) {
            await startLocalPython(folder, uri.fsPath, noDebug, settings, preset);
            return;
          }
          await vscode.debug.startDebugging(
            folder,
            {
              type: debugType,
              request: 'launch',
              name: 'Remote · ' + (preset || path.basename(uri.fsPath)),
              ...(preset
                ? { runConfiguration: preset, runhopSelectedFile: uri.fsPath }
                : { program: uri.fsPath }),
            },
            { noDebug, suppressDebugView: true, suppressSaveBeforeStart: true }
          );
        } catch (error) {
          if (!(error instanceof vscode.CancellationError)) {
            void vscode.window.showErrorMessage('RunHop: ' + error.message);
          }
        }
      })
    );
  }
}
