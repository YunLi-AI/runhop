import * as vscode from 'vscode';

function key(folder: vscode.WorkspaceFolder): string {
  return 'runhop.hasActiveRunConfiguration:' + folder.uri.toString();
}

export function hasRememberedRunConfiguration(
  state: vscode.Memento,
  folder: vscode.WorkspaceFolder
): boolean {
  return state.get(key(folder), false);
}

export function rememberRunConfigurationSelection(
  state: vscode.Memento,
  folder: vscode.WorkspaceFolder,
  activeRun: string | undefined
): void {
  const hasActiveRun = Boolean(activeRun);
  if (hasActiveRun === hasRememberedRunConfiguration(state, folder)) return;
  void state.update(key(folder), hasActiveRun || undefined).then(undefined, () => {});
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (
    uri?.scheme === 'file' &&
    vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()
  ) {
    void vscode.commands.executeCommand(
      'setContext',
      'runhop.namedConfigurationSelected',
      hasActiveRun
    );
  }
}
