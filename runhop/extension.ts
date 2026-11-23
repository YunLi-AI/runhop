import * as vscode from 'vscode';
import { removeAllRemoteFs } from './transport/core/remoteFs';
import { setManagedStorePath } from './transport/core/remote-client/hostKeyStore';
import { registerLaunch } from './launch';
import { registerConfigurations } from './configurationsPanel';
import { registerPreview } from './preview';
import { configure } from './targets';
import { initializeTransport } from './transport/logger';
import { openServerTerminal } from './remoteTerminal';
import { registerRemoteSources } from './remoteSources';
import { TerminalPanel, terminalViewId } from './terminal';
import { registerWorkbench } from './workbench';

export function activate(context: vscode.ExtensionContext): void {
  setManagedStorePath(vscode.Uri.joinPath(context.globalStorageUri, 'known_hosts').fsPath);
  const log = vscode.window.createOutputChannel('RunHop');
  const panel = new TerminalPanel(context.extensionUri);
  initializeTransport(log, context.secrets);
  context.subscriptions.push(
    log,
    panel,
    vscode.window.registerWebviewViewProvider(terminalViewId, panel),
    vscode.commands.registerCommand('runhop.openServerTerminal', async (uri?: vscode.Uri) => {
      try {
        await openServerTerminal(panel, uri);
      } catch (error) {
        void vscode.window.showErrorMessage('RunHop: ' + error.message);
      }
    }),
    vscode.commands.registerCommand('runhop.terminal.select', () => panel.select()),
    vscode.commands.registerCommand('runhop.configure', async (folder?: vscode.WorkspaceFolder) => {
      try {
        await configure(folder);
      } catch (error) {
        void vscode.window.showErrorMessage('RunHop: ' + error.message);
      }
    })
  );
  const activeConfigurationProject = registerConfigurations(context);
  registerLaunch(context, log, panel, activeConfigurationProject);
  registerRemoteSources(context, log);
  registerPreview(context);
  registerWorkbench(context, panel);
}

export function deactivate(): void {
  removeAllRemoteFs();
}
