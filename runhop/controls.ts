import * as path from 'path';
import * as vscode from 'vscode';
import { fileRunsRemotely, startLocalPython } from './fileLaunch';
import { editRunConfiguration, promptArguments, selectRunConfiguration } from './runConfigurations';
import {
  Interpreter,
  Settings,
  interpreterFor,
  isRecord,
  isRemotePython,
  launchSyncMode,
  optionsFor,
  readSettings,
  runConfigurationFor,
  scriptKey,
  scriptLaunchOptions,
  settingsFile,
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

function editorScript(resource?: vscode.Uri): EditorScript {
  const uri =
    resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
  const folder = uri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri);
  if (!uri || !folder || !vscode.workspace.isTrusted || vscode.env.remoteName) {
    throw new Error('Open a Python file in a trusted local workspace.');
  }
  return { uri, folder, key: scriptKey(folder.uri.fsPath, uri.fsPath) };
}

async function configureInterpreter(
  script: EditorScript,
  settings: Settings,
  existingName?: string
): Promise<{ name: string; interpreter: Interpreter } | undefined> {
  const existing = interpreterFor(settings, existingName);
  const matches = matchingTargets(settings.targets, script.folder.uri.fsPath, script.uri.fsPath);
  const targets = matches.filter(({ raw }, index) => {
    const name = typeof raw.name === 'string' ? raw.name : undefined;
    return name
      ? matches.filter(match => match.raw.name === name).length === 1
      : index === 0 && matches[1]?.baseDir.length !== matches[0].baseDir.length;
  });
  if (!targets.length) {
    throw new Error('Add a uniquely named SSH target covering this script in runhop.json.');
  }
  const entries = targets
    .map(({ raw }) => ({
      label: String(raw.name || raw.host || 'Default SSH target'),
      description: typeof raw.remotePath === 'string' ? raw.remotePath : undefined,
      raw,
    }))
    .sort(
      (a, b) => Number(b.raw.name === existing?.target) - Number(a.raw.name === existing?.target)
    );
  const chosen =
    entries.length === 1
      ? entries[0]
      : await vscode.window.showQuickPick(entries, {
          title: 'RunHop · SSH Target for the Interpreter',
        });
  if (!chosen) {
    return undefined;
  }
  const profiles = isRecord(chosen.raw.profiles) ? Object.keys(chosen.raw.profiles) : [];
  const defaultProfile = { label: 'Use target default', profile: undefined };
  const profileEntries = [
    defaultProfile,
    ...profiles.map(name => ({ label: name, profile: name })),
  ];
  if (existing && chosen.raw.name === existing.target) {
    profileEntries.sort(
      (a, b) => Number(b.profile === existing.profile) - Number(a.profile === existing.profile)
    );
  }
  const profile = profiles.length
    ? await vscode.window.showQuickPick(profileEntries, {
        title: 'RunHop · SSH Profile for the Interpreter',
      })
    : defaultProfile;
  if (!profile) {
    return undefined;
  }
  const python = await vscode.window.showInputBox({
    title: 'RunHop · Remote Python Executable',
    value: existing?.path,
    placeHolder: '/opt/conda/envs/my-env/bin/python',
    ignoreFocusOut: true,
    validateInput: value =>
      isRemotePython(value.trim())
        ? undefined
        : 'Enter an absolute remote path or an executable name.',
  });
  if (python === undefined) {
    return undefined;
  }
  const name =
    existingName ??
    (await vscode.window.showInputBox({
      title: 'RunHop · Name the Remote Interpreter',
      placeHolder: 'GPU Server · my-env',
      ignoreFocusOut: true,
      validateInput: value => {
        const name = value.trim();
        return !name || name === '__proto__' || Object.hasOwn(settings.interpreters || {}, name)
          ? 'Enter a new interpreter name.'
          : undefined;
      },
    }));
  if (name === undefined) {
    return undefined;
  }
  return {
    name: name.trim(),
    interpreter: {
      path: python.trim(),
      ...(typeof chosen.raw.name === 'string' && chosen.raw.name
        ? { target: chosen.raw.name }
        : {}),
      ...(profile.profile ? { profile: profile.profile } : {}),
    },
  };
}

export function registerControls(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  debugType: string,
  panel: TerminalPanel
): void {
  const selectionKey = (folder: vscode.WorkspaceFolder) =>
    'runhop.useEditorShortcuts:' + folder.uri.toString();
  const selected = (folder: vscode.WorkspaceFolder) =>
    context.workspaceState.get<boolean>(selectionKey(folder), false);
  let toolbarRevision = 0;
  async function updateToolbarContext(): Promise<void> {
    const revision = ++toolbarRevision;
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const settings = folder && (await readSettings(folder.uri.fsPath).catch(() => undefined));
    if (revision !== toolbarRevision) {
      return;
    }
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'runhop.toolbarActive',
        Boolean(folder && selected(folder))
      ),
      vscode.commands.executeCommand(
        'setContext',
        'runhop.namedConfigurationSelected',
        Boolean(settings?.activeRunConfiguration)
      ),
    ]);
  }
  async function rememberShortcuts(folder: vscode.WorkspaceFolder): Promise<void> {
    await context.workspaceState.update(selectionKey(folder), true);
    await updateToolbarContext();
  }
  async function pickConfiguration(script: EditorScript, settings: Settings): Promise<void> {
    if (await selectRunConfiguration(script.folder, settings, script.key)) {
      await rememberShortcuts(script.folder);
    }
  }
  async function editConfiguration(script: EditorScript, settings: Settings): Promise<void> {
    if (
      await editRunConfiguration(
        script.folder,
        settings,
        script.key,
        settings.activeRunConfiguration
      )
    ) {
      await rememberShortcuts(script.folder);
    }
  }
  async function selectInterpreter(script: EditorScript, settings: Settings): Promise<void> {
    const configured = optionsFor(settings, script.key).interpreter;
    const active = configured ?? settings.defaultInterpreter;
    const entries = Object.keys(settings.interpreters || {}).flatMap(name => {
      const entry = interpreterFor(settings, name)!;
      return matchingTargets(
        settings.targets,
        script.folder.uri.fsPath,
        script.uri.fsPath,
        entry.target
      ).length
        ? [
            {
              label: name,
              name,
              description: [entry.target, entry.path].filter(Boolean).join(' · '),
              detail: name === configured ? 'Selected for this script' : undefined,
            },
          ]
        : [];
    });
    const add = { label: '$(add) Add Remote Interpreter…', name: undefined };
    const edit = { label: '$(edit) Edit ' + active + '…', name: undefined };
    const useDefault = {
      label: 'Use Workspace Default',
      name: undefined,
      description: settings.defaultInterpreter || 'python3 on the matching SSH target',
    };
    const choice = await vscode.window.showQuickPick(
      [...entries, add, ...(active ? [edit] : []), useDefault],
      {
        title: 'RunHop · Remote Interpreter for ' + path.basename(script.key),
      }
    );
    if (!choice) {
      return;
    }
    const editing = choice === edit;
    const creates = choice === add;
    const save =
      editing || creates
        ? await configureInterpreter(script, settings, editing ? active : undefined)
        : undefined;
    if ((editing || creates) && !save) {
      return;
    }
    await updateSettings(script.folder, current => {
      const name = save?.name || choice.name;
      if (save && editing) {
        interpreterFor(current, save.name);
        return (['path', 'target', 'profile'] as const).map(key => ({
          at: ['interpreters', save.name, key],
          value: save.interpreter[key],
        }));
      }
      if (save && Object.hasOwn(current.interpreters || {}, save.name)) {
        throw new Error('A RunHop interpreter already uses the name ' + save.name + '.');
      }
      if (!save && name) {
        interpreterFor(current, name);
      }
      return [
        ...(save ? [{ at: ['interpreters', save.name], value: save.interpreter }] : []),
        ...(save && !current.defaultInterpreter
          ? [{ at: ['defaultInterpreter'], value: save.name }]
          : []),
        ...(name || optionsFor(current, script.key).interpreter !== undefined
          ? [{ at: ['scripts', script.key, 'interpreter'], value: name }]
          : []),
      ];
    });
    await rememberShortcuts(script.folder);
    if (save || choice.name) {
      void vscode.window.showInformationMessage(
        editing
          ? 'RunHop: Updated remote interpreter ' + save?.name + '.'
          : 'RunHop: Saved the remote interpreter for ' + script.key + '.'
      );
    }
  }

  async function editArguments(script: EditorScript, settings: Settings): Promise<void> {
    const name = settings.activeRunConfiguration;
    const options = name ? runConfigurationFor(settings, name) : optionsFor(settings, script.key);
    const args = await promptArguments(name ?? path.basename(script.key), options.args);
    if (args === undefined) {
      return;
    }
    await updateSettings(script.folder, current => {
      if (name) {
        runConfigurationFor(current, name);
      }
      return [
        {
          at: name ? ['runConfigurations', name, 'args'] : ['scripts', script.key, 'args'],
          value: args,
        },
      ];
    });
    await rememberShortcuts(script.folder);
    void vscode.window.showInformationMessage(
      'RunHop: Saved script arguments for ' + (name ?? script.key) + '.'
    );
  }

  async function launch(script: EditorScript, settings: Settings, noDebug: boolean): Promise<void> {
    const { folder, uri } = script;
    const name = settings.activeRunConfiguration;
    const isPython =
      /\.pyw?$/i.test(uri.fsPath) ||
      vscode.workspace.textDocuments.some(
        doc => doc.uri.toString() === uri.toString() && doc.languageId === 'python'
      );
    if (!name && !isPython) {
      throw new Error('Open a Python file or select a saved RunHop configuration.');
    }
    const { program } = scriptLaunchOptions(settings, folder.uri.fsPath, uri.fsPath, name);
    if (program && !fileRunsRemotely(settings, folder.uri.fsPath, program, name)) {
      if (await startLocalPython(folder, program, noDebug, settings, name)) {
        await rememberShortcuts(folder);
      }
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
    const item = await vscode.window.showQuickPick(
      [
        { label: 'Use Project Setting', description: projectDefault, value: undefined },
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
      ],
      { title: 'RunHop · Sync Before Launch · ' + (name ?? script.key) }
    );
    if (item) {
      await updateSettings(script.folder, current => {
        if (name) {
          runConfigurationFor(current, name);
        }
        return [
          {
            at: name
              ? ['runConfigurations', name, 'syncMode']
              : ['scripts', script.key, 'syncMode'],
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
      ],
      { title: 'RunHop · Upload on Save · Project Setting' }
    );
    if (choice) {
      await updateSettings(folder, () => [{ at: ['uploadOnSave'], value: choice.value }]);
    }
  }

  async function openControls(script: EditorScript, settings: Settings): Promise<void> {
    const name = settings.activeRunConfiguration;
    let program = script.key;
    let options = name ? {} : optionsFor(settings, script.key);
    let remote = Boolean(name);
    if (name) {
      try {
        const selected = scriptLaunchOptions(
          settings,
          script.folder.uri.fsPath,
          script.uri.fsPath,
          name
        );
        program = scriptKey(script.folder.uri.fsPath, selected.program!);
        options = selected.options;
        remote = fileRunsRemotely(settings, script.folder.uri.fsPath, selected.program!, name);
      } catch {
        // Keep the selector available if a manual edit removed the active entry.
        options = {};
      }
    } else {
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
      {
        label: remote ? '$(debug-alt) Debug on Server' : '$(debug-alt) Debug Locally',
        run: () => launch(script, settings, false),
      },
      {
        label: remote ? '$(play) Run on Server' : '$(play) Run Locally',
        run: () => launch(script, settings, true),
      },
      {
        label: '$(terminal) Open Terminal on Server',
        run: () => vscode.commands.executeCommand('runhop.openServerTerminal', script.uri),
      },
      {
        label: '$(list-selection) Select Run Configuration…',
        description: name || 'Current Python File',
        run: () => pickConfiguration(script, settings),
      },
      name
        ? {
            label: '$(edit) Edit Run Configuration…',
            description: name,
            run: () => editConfiguration(script, settings),
          }
        : {
            label: '$(server) Remote Interpreter…',
            description: interpreterName || 'python3',
            run: () => selectInterpreter(script, settings),
          },
      {
        label: '$(list-unordered) Script Arguments…',
        description: options.args?.length ? options.args.length + ' saved' : undefined,
        run: () => editArguments(script, settings),
      },
      {
        label: '$(debug-breakpoint) View Breakpoints',
        run: () => vscode.commands.executeCommand('runhop.breakpoints'),
      },
      { label: '$(json) Open RunHop Configuration', run: () => configure(script.folder) },
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
      title: 'RunHop · ' + (name ?? script.key),
      placeHolder: interpreter
        ? [program, interpreter.target, interpreter.path].filter(Boolean).join(' · ')
        : [program, !remote && 'VS Code local interpreter'].filter(Boolean).join(' · '),
    });
    await action?.run();
  }

  function command(
    id: string,
    run: (script: EditorScript, settings: Settings) => Promise<void>
  ): vscode.Disposable {
    return vscode.commands.registerCommand(id, async resource => {
      try {
        const script = editorScript(resource);
        const settings = await readSettings(script.folder.uri.fsPath).catch(async error => {
          if (error.code === 'ENOENT') {
            await configure(script.folder);
            return;
          }
          throw error;
        });
        if (settings) {
          await run(script, settings);
        }
      } catch (error) {
        if (!(error instanceof vscode.CancellationError)) {
          void vscode.window.showErrorMessage('RunHop: ' + error.message);
        }
      }
    });
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/' + settingsFile.split(path.sep).join('/')
  );
  context.subscriptions.push(
    command('runhop.controls', openControls),
    command('runhop.selectRunConfiguration', pickConfiguration),
    command('runhop.selectTarget', selectInterpreter),
    command('runhop.editArguments', editArguments),
    command('runhop.run', (script, settings) => launch(script, settings, true)),
    command('runhop.debug', (script, settings) => launch(script, settings, false)),
    vscode.window.onDidChangeActiveTextEditor(updateToolbarContext),
    watcher,
    watcher.onDidCreate(updateToolbarContext),
    watcher.onDidChange(updateToolbarContext),
    watcher.onDidDelete(updateToolbarContext)
  );
  void updateToolbarContext();
}
