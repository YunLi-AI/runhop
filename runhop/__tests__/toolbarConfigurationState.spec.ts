import * as vscode from 'vscode';
import { registerControls } from '../controls';
import { registerFileLaunch } from '../fileLaunch';
import * as settings from '../settings';
import type { TerminalPanel } from '../terminal';
import { rememberRunConfigurationSelection } from '../toolbarConfigurationState';

jest.mock('vscode', () => ({
  Uri: class Uri {},
  l10n: { t: (message: string) => message },
  env: { language: 'en' },
  debug: { startDebugging: jest.fn(async () => true) },
  commands: {
    executeCommand: jest.fn(async () => undefined),
    registerCommand: jest.fn(() => ({ dispose() {} })),
  },
  window: {
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose() {} })),
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(async () => undefined),
    showQuickPick: jest.fn(async () => undefined),
  },
  workspace: { getWorkspaceFolder: jest.fn(), isTrusted: true },
}));

function registerToolbar() {
  const folder = {
    uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' },
  } as vscode.WorkspaceFolder;
  const values = new Map<string, unknown>();
  const state: vscode.Memento = {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  const context = {
    workspaceState: state,
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const file = { scheme: 'file', fsPath: '/project/script.py' };
  Object.assign(vscode.window, { activeTextEditor: { document: { uri: file } } });
  jest.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(folder);
  registerControls(
    context,
    {} as vscode.OutputChannel,
    'runhop-python',
    { selectedExecution: () => undefined } as unknown as TerminalPanel,
    () => undefined
  );
  registerFileLaunch(context, 'runhop-python');
  return { folder, state, file };
}

async function invoke(id: string) {
  const command = jest
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([key]) => key === id);
  if (!command) throw new Error('Command was not registered: ' + id);
  await command[1]();
}

beforeEach(() => jest.clearAllMocks());

test('toolbar activation and editor changes use the remembered selection without reading configuration files', () => {
  const read = jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue(undefined);
  try {
    const { folder, state } = registerToolbar();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'runhop.namedConfigurationSelected',
      false
    );

    rememberRunConfigurationSelection(state, folder, 'Train');
    jest.mocked(vscode.commands.executeCommand).mockClear();
    const [[editorChanged]] = jest.mocked(vscode.window.onDidChangeActiveTextEditor).mock.calls;
    editorChanged(vscode.window.activeTextEditor);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'runhop.namedConfigurationSelected',
      true
    );
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

test('the RunHop menu opens when the project has no configuration file', async () => {
  const read = jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue(undefined);
  try {
    registerToolbar();
    await invoke('runhop.controls');
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: '$(play) Run Python' })]),
      expect.anything()
    );
    expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

const launchCommands = [
  ['runhop.run', true],
  ['runhop.debug', false],
  ['runhop.file.run', true],
  ['runhop.file.debug', false],
] as const;

test.each(launchCommands)(
  '%s prompts for manual configuration when runhop.json is missing',
  async id => {
    const read = jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue(undefined);
    const save = jest.spyOn(settings, 'updateSettings');
    try {
      registerToolbar();
      await invoke(id);
      expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Save a RunHop configuration before running or debugging this project.',
        'Open Configurations'
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'runhop.configurations',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      expect(save).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      save.mockRestore();
    }
  }
);

test('opens the editor only after the user selects Open Configurations', async () => {
  const read = jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue(undefined);
  const notify = vscode.window.showInformationMessage as (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  jest.mocked(notify).mockResolvedValueOnce('Open Configurations');
  try {
    const { folder, file } = registerToolbar();
    await invoke('runhop.run');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'runhop.configurations',
      folder,
      { section: 'run' },
      file
    );
    expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

test.each(launchCommands)(
  '%s starts a local RunHop session for the configured program without a Python extension',
  async (id, noDebug) => {
    const read = jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue({
      targets: [],
      scripts: { 'script.py': { runOn: 'local', args: ['--from-json'] } },
    });
    try {
      const { folder, file } = registerToolbar();
      await invoke(id);
      expect(vscode.debug.startDebugging).toHaveBeenCalledWith(
        folder,
        expect.objectContaining({
          type: 'runhop-python',
          runhopLocal: true,
          program: file.fsPath,
          noDebug,
        }),
        expect.objectContaining({ noDebug })
      );
    } finally {
      read.mockRestore();
    }
  }
);
