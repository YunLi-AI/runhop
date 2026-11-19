import { stat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isLocalPathAtOrUnder } from './paths';
import { formatArguments, parseArguments } from './arguments';
import {
  Settings,
  interpreterFor,
  isRecord,
  optionsFor,
  runConfigurationFor,
  scriptKey,
  updateSettings,
} from './settings';
import { matchingTargets } from './targets';

export async function promptArguments(
  label: string,
  args: string[] = []
): Promise<string[] | undefined> {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('Fix args for ' + label + ' in runhop.json before editing through RunHop.');
  }
  const input = await vscode.window.showInputBox({
    title: 'RunHop · Script Arguments for ' + label,
    value: formatArguments(args),
    placeHolder: '--flag "/remote/directory with spaces"',
    prompt: 'Quote arguments that contain spaces. A blank line clears the arguments.',
    ignoreFocusOut: true,
    validateInput: value => {
      try {
        parseArguments(value);
        return undefined;
      } catch (error) {
        return error.message;
      }
    },
  });
  return input === undefined ? undefined : parseArguments(input);
}

async function promptPath(
  title: string,
  workspace: string,
  inside: string,
  value: string,
  directory = false,
  remote = true
): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({
    title,
    value,
    prompt: directory
      ? remote
        ? 'Enter the local directory to map to the server, relative to the workspace.'
        : 'Enter the local working directory, relative to the workspace.'
      : 'Enter the path of the local Python script, relative to the workspace.',
    ignoreFocusOut: true,
    async validateInput(input) {
      const full = path.resolve(workspace, input);
      if (!input.trim() || input.includes('\0') || !isLocalPathAtOrUnder(inside, full)) {
        return 'Enter a path within the mapped project.';
      }
      const info = await stat(full).catch(() => undefined);
      return (directory ? info?.isDirectory() : info?.isFile())
        ? undefined
        : 'Enter an existing ' + (directory ? 'directory.' : 'script file.');
    },
  });
  return answer === undefined
    ? undefined
    : scriptKey(workspace, path.resolve(workspace, answer)) || '.';
}

export async function editRunConfiguration(
  folder: vscode.WorkspaceFolder,
  settings: Settings,
  currentFile: string,
  existingName?: string
): Promise<boolean> {
  const workspace = folder.uri.fsPath;
  const existing =
    existingName === undefined ? undefined : runConfigurationFor(settings, existingName);
  const name =
    existingName ??
    (
      await vscode.window.showInputBox({
        title: 'RunHop · New Run Configuration',
        prompt: 'Enter a name for this run configuration.',
        ignoreFocusOut: true,
        validateInput: input => {
          const name = input.trim();
          return !name ||
            name === '__proto__' ||
            Object.hasOwn(settings.runConfigurations || {}, name)
            ? 'Enter a new configuration name.'
            : undefined;
        },
      })
    )?.trim();
  if (name === undefined) {
    return false;
  }
  const program = await promptPath(
    'RunHop · Python Script',
    workspace,
    workspace,
    existing?.program ?? currentFile
  );
  if (program === undefined) {
    return false;
  }
  const local = path.resolve(workspace, program);
  const options = existing ?? optionsFor(settings, program);
  const available = (name?: string) => {
    const interpreter = interpreterFor(settings, name ?? settings.defaultInterpreter);
    return matchingTargets(settings.targets, workspace, local, interpreter?.target);
  };
  const interpreters = [
    {
      label: 'Use Workspace Default',
      description: settings.defaultInterpreter || 'python3',
      name: undefined,
    },
    ...Object.keys(settings.interpreters || {}).map(name => ({
      label: name,
      description: interpreterFor(settings, name)?.path,
      name,
    })),
  ]
    .filter(item => available(item.name).length)
    .sort(
      (a, b) => Number(b.name === options.interpreter) - Number(a.name === options.interpreter)
    );
  const remoteChoices = interpreters.map(item => ({ ...item, runOn: 'remote' as const }));
  const localChoice = {
    label: 'VS Code Local Interpreter',
    name: undefined,
    runOn: 'local' as const,
  };
  const choices =
    options.runOn === 'local' ? [localChoice, ...remoteChoices] : [...remoteChoices, localChoice];
  const selected = await vscode.window.showQuickPick(choices, {
    title: 'RunHop · Python Interpreter for ' + name,
  });
  if (!selected) {
    return false;
  }
  const matches = selected.runOn === 'remote' ? available(selected.name) : [];
  if (matches[1]?.baseDir.length === matches[0].baseDir.length) {
    throw new Error('Select an interpreter linked to a named SSH target for ' + program + '.');
  }
  const base = matches[0]?.baseDir ?? workspace;
  const cwd = await promptPath(
    'RunHop · Working Directory for ' + name,
    workspace,
    base,
    options.cwd ?? (scriptKey(workspace, base) || '.'),
    true,
    selected.runOn === 'remote'
  );
  if (cwd === undefined) {
    return false;
  }
  const args = await promptArguments(name, options.args);
  if (args === undefined) {
    return false;
  }
  await updateSettings(folder, current => {
    const exists = Object.hasOwn(current.runConfigurations || {}, name);
    if (exists !== Boolean(existing)) {
      throw new Error(
        'The saved configuration list changed. Open the RunHop selector to try again.'
      );
    }
    if (selected.runOn === 'remote') {
      interpreterFor(current, selected.name ?? current.defaultInterpreter);
    }
    const fields = { program, runOn: selected.runOn, interpreter: selected.name, cwd, args };
    return [
      ...(existing
        ? Object.entries(fields).map(([key, value]) => ({
            at: ['runConfigurations', name, key],
            value,
          }))
        : [{ at: ['runConfigurations', name], value: { ...options, ...fields } }]),
      { at: ['activeRunConfiguration'], value: name },
    ];
  });
  return true;
}

export async function selectRunConfiguration(
  folder: vscode.WorkspaceFolder,
  settings: Settings,
  currentFile: string
): Promise<boolean> {
  const current = { label: 'Current Python File', name: undefined };
  const add = { label: '$(add) New Run Configuration…', name: undefined };
  const entries = Object.entries(settings.runConfigurations || {}).map(([name, config]) => ({
    label: name,
    name,
    description:
      isRecord(config) && typeof config.program === 'string' ? config.program : undefined,
    detail: name === settings.activeRunConfiguration ? 'Selected for Run and Debug' : undefined,
  }));
  const choice = await vscode.window.showQuickPick([...entries, current, add], {
    title: 'RunHop · Select Run Configuration',
  });
  if (!choice) {
    return false;
  }
  if (choice === add) {
    return editRunConfiguration(folder, settings, currentFile);
  }
  await updateSettings(folder, latest => {
    if (choice.name !== undefined) {
      runConfigurationFor(latest, choice.name);
    }
    return choice.name === latest.activeRunConfiguration
      ? []
      : [{ at: ['activeRunConfiguration'], value: choice.name }];
  });
  return true;
}
