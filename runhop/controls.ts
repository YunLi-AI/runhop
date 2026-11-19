import * as path from 'path';
import * as vscode from 'vscode';
import {
  hasRememberedRunConfiguration,
  rememberRunConfigurationSelection,
} from './toolbarConfigurationState';
import { fileRunsRemotely, startLocalPython } from './fileLaunch';
import { promptToConfigureRun, selectRunConfiguration } from './runConfigurations';
import type { ConfigurationFocus } from './configurationsModel';
import type { ConfigurationEditorProject } from './configurationsPanel';
import {
  Interpreter,
  Settings,
  interpreterFor,
  launchSyncMode,
  optionsFor,
  readOptionalSettings,
  runConfigurationFor,
  scriptKey,
  scriptLaunchOptions,
  updateSettings,
} from './settings';
import { configure, matchingTargets } from './targets';
import type { TerminalPanel } from './terminal';

interface EditorScript {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  key: string;
}

const launchSyncLabel = { full: 'Project Scan', incremental: 'Changed Files', off: 'Off' };
const emptySettings: Settings = { targets: [] };

function editorScript(
  resource: unknown,
  configurationProject: ConfigurationEditorProject | undefined
): EditorScript {
  if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
    throw new Error('Open a trusted local workspace to use RunHop.');
  }
  const explicitFile =
    resource instanceof vscode.Uri && resource.scheme === 'file' ? resource : undefined;
  if (!explicitFile && configurationProject) {
    const { folder, script } = configurationProject;
    return {
      uri: script ? vscode.Uri.file(path.resolve(folder.uri.fsPath, script)) : folder.uri,
      folder,
      key: script ?? '',
    };
  }
  const uri = explicitFile ?? vscode.window.activeTextEditor?.document.uri;
  const folder = uri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri);
  if (!uri || !folder) throw new Error('Open a Python file in a trusted local workspace.');
  return { uri, folder, key: scriptKey(folder.uri.fsPath, uri.fsPath) };
}

export function registerControls(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  debugType: string,
  panel: TerminalPanel,
  activeConfigurationProject: () => ConfigurationEditorProject | undefined
): void {
  const selectionKey = (folder: vscode.WorkspaceFolder) =>
    'runhop.useEditorShortcuts:' + folder.uri.toString();
  const selected = (folder: vscode.WorkspaceFolder) =>
    context.workspaceState.get<boolean>(selectionKey(folder), false);
  async function updateToolbarContext(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'runhop.toolbarActive',
        Boolean(folder && selected(folder))
      ),
      vscode.commands.executeCommand(
        'setContext',
        'runhop.namedConfigurationSelected',
        Boolean(folder && hasRememberedRunConfiguration(context.workspaceState, folder))
      ),
    ]);
  }
  async function rememberShortcuts(folder: vscode.WorkspaceFolder): Promise<void> {
    await context.workspaceState.update(selectionKey(folder), true);
    await updateToolbarContext();
  }
  async function pickConfiguration(script: EditorScript, settings: Settings): Promise<void> {
    const selection = await selectRunConfiguration(
      script.folder,
      settings,
      script.key ? script.uri : undefined
    );
    if (selection) {
      rememberRunConfigurationSelection(context.workspaceState, script.folder, selection.name);
      await rememberShortcuts(script.folder);
    }
  }
  async function showConfigurations(
    script: EditorScript,
    focus?: ConfigurationFocus
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'runhop.configurations',
      script.folder,
      focus,
      script.key ? script.uri : undefined
    );
  }

  async function editConfiguration(
    script: EditorScript,
    settings: Settings,
    field?: string
  ): Promise<void> {
    await showConfigurations(script, {
      section: 'run',
      key: settings.activeRunConfiguration
        ? 'run:' + settings.activeRunConfiguration
        : script.key
          ? 'file'
          : 'current',
      field,
    });
  }

  async function selectInterpreter(script: EditorScript, settings: Settings): Promise<void> {
    const workspace = script.folder.uri.fsPath;
    const name = settings.activeRunConfiguration;
    const { program, options } = scriptLaunchOptions(
      settings,
      workspace,
      script.key ? script.uri.fsPath : undefined,
      name
    );
    const anchor = program ?? (options.cwd ? path.resolve(workspace, options.cwd) : workspace);
    const usesProjectDefault = !name && !script.key;
    const configured = usesProjectDefault
      ? settings.defaultInterpreter
      : name
        ? runConfigurationFor(settings, name).interpreter
        : options.interpreter;
    const entries = Object.keys(settings.interpreters ?? {}).flatMap(name => {
      const entry = interpreterFor(settings, name)!;
      return usesProjectDefault ||
        matchingTargets(settings.targets, workspace, anchor, entry.target).length
        ? [
            {
              label: name,
              name,
              description: [entry.target, entry.path].filter(Boolean).join(' · '),
              detail: name === configured ? 'Selected' : undefined,
            },
          ]
        : [];
    });
    const add = { label: '$(add) Add Remote Interpreter…', name: undefined };
    const manage = { label: '$(list-tree) Manage Remote Interpreters…', name: undefined };
    const useDefault = {
      label: usesProjectDefault ? 'Automatic' : 'Use Workspace Default',
      name: undefined,
      description: usesProjectDefault
        ? 'python3 on the matching SSH target'
        : settings.defaultInterpreter || 'python3 on the matching SSH target',
    };
    const choice = await vscode.window.showQuickPick([...entries, useDefault, add, manage], {
      title:
        'RunHop · Remote Interpreter for ' +
        (name ?? (script.key ? path.basename(script.key) : script.folder.name)),
    });
    if (!choice) return;
    if (choice === add || choice === manage) {
      const active = configured ?? settings.defaultInterpreter;
      await showConfigurations(script, {
        section: 'interpreters',
        key: active ? 'python:' + active : undefined,
        create: choice === add,
      });
      return;
    }
    await updateSettings(script.folder, current => {
      if (name) runConfigurationFor(current, name);
      if (choice.name) interpreterFor(current, choice.name);
      if (usesProjectDefault) return [{ at: ['defaultInterpreter'], value: choice.name }];
      const at = name ? ['runConfigurations', name] : ['scripts', script.key];
      return [
        { at: [...at, 'interpreter'], value: choice.name },
        ...(choice.name && options.runOn === 'local'
          ? [{ at: [...at, 'runOn'], value: 'remote' }]
          : []),
      ];
    });
    await rememberShortcuts(script.folder);
  }

  async function launch(
    script: EditorScript,
    settings: Settings | undefined,
    noDebug: boolean
  ): Promise<void> {
    const { folder, uri } = script;
    if (!settings) {
      await promptToConfigureRun(folder, script.key ? uri : undefined);
      return;
    }
    const name = settings.activeRunConfiguration;
    const isPython =
      /\.pyw?$/i.test(uri.fsPath) ||
      vscode.workspace.textDocuments.some(
        doc => doc.uri.toString() === uri.toString() && doc.languageId === 'python'
      );
    if (!name && (!script.key || !isPython)) {
      throw new Error('Open a Python file or select a saved RunHop configuration.');
    }
    const { program } = scriptLaunchOptions(settings, folder.uri.fsPath, uri.fsPath, name);
    if (!fileRunsRemotely(settings, folder.uri.fsPath, program, name)) {
      if (await startLocalPython(folder, program, noDebug, settings, name)) {
        await rememberShortcuts(folder);
      }
      return;
    }
    if (!settings.targets.length) {
      await showConfigurations(script, { section: 'servers' });
      return;
    }
    if (!noDebug) {
      await vscode.commands.executeCommand('workbench.view.explorer');
    }
    const started = await vscode.debug.startDebugging(
      folder,
      {
        type: debugType,
        request: 'launch',
        name: name || path.basename(uri.fsPath),
        ...(name ? { runConfiguration: name } : { program: uri.fsPath }),
      },
      { noDebug, suppressDebugView: true, suppressSaveBeforeStart: true }
    );
    if (started) {
      await rememberShortcuts(folder);
    }
  }

  async function editLaunchSync(script: EditorScript, settings: Settings): Promise<void> {
    const name = settings.activeRunConfiguration;
    const projectDefault = launchSyncLabel[launchSyncMode(settings)];
    const perRun = Boolean(name || script.key);
    const item = await vscode.window.showQuickPick(
      [
        ...(perRun
          ? [{ label: 'Use Project Setting', description: projectDefault, value: undefined }]
          : []),
        {
          label: 'Changed Files',
          description: 'Upload local changes before starting',
          value: 'incremental',
        },
        {
          label: 'Project Scan',
          description: 'Compare the project with the server before starting',
          value: 'full',
        },
        { label: 'Off', description: 'Use the project files already on the server', value: 'off' },
        { label: '$(list-tree) RunHop Configurations…', value: 'manage' },
      ],
      { title: 'RunHop · Sync Before Launch · ' + (name ?? (script.key || script.folder.name)) }
    );
    if (item?.value === 'manage') {
      if (perRun) await editConfiguration(script, settings, 'syncMode');
      else await showConfigurations(script, { section: 'sync', field: 'syncMode' });
    } else if (item) {
      await updateSettings(script.folder, current => {
        if (name) {
          runConfigurationFor(current, name);
        }
        return [
          {
            at: name
              ? ['runConfigurations', name, 'syncMode']
              : perRun
                ? ['scripts', script.key, 'syncMode']
                : ['syncMode'],
            value: item.value,
          },
        ];
      });
    }
  }

  async function editUploadOnSave(folder: vscode.WorkspaceFolder): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'On', description: 'Upload eligible files when saved', value: true },
        { label: 'Off', value: false },
        { label: '$(list-tree) RunHop Configurations…', value: undefined },
      ],
      { title: 'RunHop · Upload on Save · Project Setting' }
    );
    if (choice?.value === undefined && choice) {
      await vscode.commands.executeCommand('runhop.configurations', folder, { section: 'sync' });
    } else if (choice) {
      await updateSettings(folder, () => [{ at: ['uploadOnSave'], value: choice.value }]);
    }
  }

  async function openControls(script: EditorScript, savedSettings: Settings | undefined) {
    const settings = savedSettings ?? emptySettings;
    const name = settings.activeRunConfiguration;
    let program = script.key;
    let options = name || !script.key ? {} : optionsFor(settings, script.key);
    let remote = Boolean(name);
    if (name) {
      try {
        const selected = scriptLaunchOptions(
          settings,
          script.folder.uri.fsPath,
          script.uri.fsPath,
          name
        );
        program = selected.program
          ? scriptKey(script.folder.uri.fsPath, selected.program)
          : (selected.module ?? '');
        options = selected.options;
        remote = fileRunsRemotely(settings, script.folder.uri.fsPath, selected.program, name);
      } catch {
        // Keep the selector available if a manual edit removed the active entry.
        options = {};
      }
    } else if (savedSettings && script.key) {
      remote = fileRunsRemotely(settings, script.folder.uri.fsPath, script.uri.fsPath);
    }
    const interpreterName = options.interpreter ?? settings.defaultInterpreter;
    let interpreter: Interpreter | undefined;
    try {
      interpreter = remote ? interpreterFor(settings, interpreterName) : undefined;
    } catch {
      // The interpreter picker or JSON editor can repair a stale reference.
    }
    const actions = [
      ...(name || script.key
        ? [
            {
              label: '$(debug-alt) Debug Python',
              run: async () => launch(script, await projectSettings(script.folder), false),
            },
            {
              label: '$(play) Run Python',
              run: async () => launch(script, await projectSettings(script.folder), true),
            },
          ]
        : []),
      {
        label: '$(terminal) Open Terminal on Server',
        run: () => vscode.commands.executeCommand('runhop.openServerTerminal', script.uri),
      },
      {
        label: '$(list-selection) Select Run Configuration…',
        description: name || 'Current Python File',
        run: () => pickConfiguration(script, settings),
      },
      {
        label: '$(server) Remote Interpreter…',
        description: interpreterName || 'python3',
        run: () => selectInterpreter(script, settings),
      },
      {
        label: '$(list-tree) RunHop Configurations…',
        description: name || 'Current Python File',
        run: () => editConfiguration(script, settings),
      },
      {
        label: '$(list-unordered) Script Arguments…',
        description: options.args?.length ? options.args.length + ' saved' : undefined,
        run: () => editConfiguration(script, settings, 'args'),
      },
      {
        label: '$(debug-breakpoint) View Breakpoints',
        run: () => vscode.commands.executeCommand('runhop.breakpoints'),
      },
      { label: '$(json) Open runhop.json', run: () => configure(script.folder) },
      { label: '$(output) Show RunHop Output', run: () => log.show(true) },
    ];
    actions.splice(
      actions.length - 2,
      0,
      {
        label: '$(sync) Sync Before Launch…',
        description: launchSyncLabel[launchSyncMode(settings, options.syncMode)],
        run: () => editLaunchSync(script, settings),
      },
      {
        label: '$(cloud-upload) Upload on Save…',
        description: settings.uploadOnSave !== false ? 'On' : 'Off',
        run: () => editUploadOnSave(script.folder),
      }
    );
    if (selected(script.folder)) {
      actions.push({
        label: 'Use VS Code Default Shortcuts',
        run: async () => {
          await context.workspaceState.update(selectionKey(script.folder), undefined);
          await updateToolbarContext();
        },
      });
    }
    const execution = panel.selectedExecution(script.folder.uri.toString());
    if (execution) {
      actions.unshift({
        label: '$(debug-stop) Stop Selected Session',
        run: () => panel.stopSelected(execution.id),
      });
    }
    const action = await vscode.window.showQuickPick(actions, {
      title: 'RunHop · ' + (name ?? (script.key || script.folder.name)),
      placeHolder: !savedSettings
        ? 'Save a RunHop configuration to run or debug this project'
        : interpreter
          ? [program, interpreter.target, interpreter.path].filter(Boolean).join(' · ')
          : [program, !remote && 'VS Code local interpreter'].filter(Boolean).join(' · '),
    });
    await action?.run();
  }

  async function projectSettings(folder: vscode.WorkspaceFolder): Promise<Settings | undefined> {
    const settings = await readOptionalSettings(folder.uri.fsPath);
    rememberRunConfigurationSelection(
      context.workspaceState,
      folder,
      settings?.activeRunConfiguration
    );
    return settings;
  }

  function command(
    id: string,
    run: (script: EditorScript, settings: Settings | undefined) => Promise<void>
  ): vscode.Disposable {
    return vscode.commands.registerCommand(id, async resource => {
      try {
        const script = editorScript(resource, activeConfigurationProject());
        await run(script, await projectSettings(script.folder));
      } catch (error) {
        if (!(error instanceof vscode.CancellationError)) {
          void vscode.window.showErrorMessage('RunHop: ' + error.message);
        }
      }
    });
  }

  context.subscriptions.push(
    command('runhop.controls', openControls),
    command('runhop.selectRunConfiguration', (script, settings) =>
      pickConfiguration(script, settings ?? emptySettings)
    ),
    command('runhop.selectTarget', (script, settings) =>
      selectInterpreter(script, settings ?? emptySettings)
    ),
    command('runhop.editArguments', (script, settings) =>
      editConfiguration(script, settings ?? emptySettings, 'args')
    ),
    command('runhop.run', (script, settings) => launch(script, settings, true)),
    command('runhop.debug', (script, settings) => launch(script, settings, false)),
    vscode.window.onDidChangeActiveTextEditor(updateToolbarContext)
  );
  void updateToolbarContext();
}
