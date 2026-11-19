import * as vscode from 'vscode';
import { configurationLocale, configurationText } from './configurationLocale';
import { Settings, isRecord, runConfigurationFor, updateSettings } from './settings';

export async function promptToConfigureRun(
  folder: vscode.WorkspaceFolder,
  currentFile?: vscode.Uri
): Promise<void> {
  const locale = configurationLocale('auto', vscode.env.language);
  const open = configurationText(locale, 'Open Configurations');
  const choice = await vscode.window.showInformationMessage(
    configurationText(
      locale,
      'Save a RunHop configuration before running or debugging this project.'
    ),
    open
  );
  if (choice !== open) return;
  await vscode.commands.executeCommand(
    'runhop.configurations',
    folder,
    { section: 'run' },
    currentFile
  );
}

export async function selectRunConfiguration(
  folder: vscode.WorkspaceFolder,
  settings: Settings,
  currentFile?: vscode.Uri
): Promise<{ name?: string } | undefined> {
  const current = { label: 'Current Python File', name: undefined };
  const manage = { label: '$(list-tree) RunHop Configurations…', name: undefined };
  const add = { label: '$(add) New Run Configuration…', name: undefined };
  const entries = Object.entries(settings.runConfigurations ?? {}).map(([name, config]) => ({
    label: name,
    name,
    description: isRecord(config) ? (config.program ?? config.module) : undefined,
    detail: name === settings.activeRunConfiguration ? 'Selected for Run and Debug' : undefined,
  }));
  const choice = await vscode.window.showQuickPick([...entries, current, add, manage], {
    title: 'RunHop · Select Run Configuration',
  });
  if (!choice) return;
  if (choice === add || choice === manage) {
    await vscode.commands.executeCommand(
      'runhop.configurations',
      folder,
      { section: 'run', create: choice === add },
      currentFile
    );
    return;
  }
  await updateSettings(folder, latest => {
    if (choice.name !== undefined) runConfigurationFor(latest, choice.name);
    return choice.name === latest.activeRunConfiguration
      ? []
      : [{ at: ['activeRunConfiguration'], value: choice.name }];
  });
  return { name: choice.name };
}
