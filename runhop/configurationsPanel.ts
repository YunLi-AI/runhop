import { createHmac, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { rememberRunConfigurationSelection } from './toolbarConfigurationState';
import { readConfigurationColumnWidths } from './configurationLayout';
import {
  ConfigurationInputError,
  ConfigurationLanguageMode,
  configurationLocale,
  configurationText,
  isConfigurationLanguageMode,
} from './configurationLocale';
import {
  ConfigurationFocus,
  ConfigurationSection,
  configurationEdits,
  configurationRows,
  makeInterpreter,
  makeServer,
  requireFields,
  sections,
  targetProfiles,
} from './configurationsModel';
import { checkConfigurationPython, testConfigurationServer } from './configurationProbes';
import { isLocalPathAtOrUnder } from './paths';
import {
  isRecord,
  parseSettings,
  readSettingsText,
  scriptKey,
  Settings,
  settingsFile,
  updateSettings,
} from './settings';
import { configure } from './targets';
import { sshHostAliases } from './transport/core/sshConfiguration';

const snapshotSecret = randomBytes(32);
const languageKey = 'runhop.configurations.language';
const columnWidthsKey = 'runhop.configurations.columnWidths';
const panelTitle = 'RunHop Configurations';
const workspaceKey = (folder: vscode.WorkspaceFolder) => folder.uri.toString();
const folders = () =>
  (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');

function trusted() {
  if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
    throw new Error('RunHop Configurations requires a trusted local workspace.');
  }
}

function focusFor(input: unknown): ConfigurationFocus | undefined {
  if (!isRecord(input) || !sections.includes(input.section as ConfigurationSection)) return;
  return {
    section: input.section as ConfigurationSection,
    key: typeof input.key === 'string' ? input.key : undefined,
    field: typeof input.field === 'string' ? input.field : undefined,
    create: input.create === true,
  };
}

async function sourceFor(folder: vscode.WorkspaceFolder) {
  const text = await readSettingsText(folder.uri.fsPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return {
    text,
    revision:
      text === null ? 'missing' : createHmac('sha256', snapshotSecret).update(text).digest('hex'),
    settings: parseSettings(text ?? '{}'),
  };
}

function safeError(error: unknown, settings?: Settings) {
  let message = error instanceof Error ? error.message : 'The operation failed.';
  let chinese =
    error instanceof ConfigurationInputError
      ? configurationText('zh-CN', error.template, ...error.values)
      : configurationText('zh-CN', message);
  function redact(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(redact);
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (/password|passphrase|private.?key$/i.test(key) && typeof item === 'string' && item) {
          message = message.split(item).join('[hidden]');
          chinese = chinese.split(item).join('[hidden]');
        } else if (item && typeof item === 'object') {
          redact(item);
        }
      }
    }
  }
  redact(settings?.targets);
  return { error: message.slice(0, 1600), errorZh: chinese.slice(0, 1600) };
}

export interface ConfigurationEditorProject {
  folder: vscode.WorkspaceFolder;
  script?: string;
}

export function registerConfigurations(
  context: vscode.ExtensionContext
): () => ConfigurationEditorProject | undefined {
  const root = vscode.Uri.joinPath(context.extensionUri, 'resources');
  let panel: vscode.WebviewPanel | undefined;
  let folder: vscode.WorkspaceFolder | undefined;
  let sourceWatch: vscode.FileSystemWatcher | undefined;
  let currentScript: string | undefined;
  let initial: ConfigurationFocus | undefined;
  let revisionCounter = 0;
  let busy = false;
  let ready = false;

  const language = () => {
    const saved = context.globalState.get(languageKey);
    const mode: ConfigurationLanguageMode = isConfigurationLanguageMode(saved) ? saved : 'auto';
    return { mode, locale: configurationLocale(mode, vscode.env.language) };
  };

  const send = (value: Record<string, unknown>) => {
    void panel?.webview.postMessage(value);
  };

  async function snapshot(force = false, focus?: ConfigurationFocus, applied = false) {
    if (!panel || !ready || !folder) return;
    const sequence = ++revisionCounter;
    const current = folder;
    try {
      trusted();
      if (!folders().some(item => workspaceKey(item) === workspaceKey(current))) {
        throw new Error('This folder was removed from the workspace. Select another project.');
      }
      const source = await sourceFor(current);
      if (sequence !== revisionCounter) return;
      rememberRunConfigurationSelection(
        context.workspaceState,
        current,
        source.settings.activeRunConfiguration
      );
      send({
        type: 'snapshot',
        folder: workspaceKey(current),
        folders: folders().map(item => ({
          id: workspaceKey(item),
          name: item.name,
          path: item.uri.fsPath,
        })),
        workspace: current.uri.fsPath,
        script: currentScript,
        revision: source.revision,
        missing: source.text === null,
        entries: configurationRows(source.settings, currentScript),
        profiles: targetProfiles(source.settings),
        focus,
        force,
        applied,
      });
    } catch (error) {
      if (sequence === revisionCounter) {
        send({
          type: 'error',
          ...safeError(error),
          source: true,
          folder: workspaceKey(current),
          folders: folders().map(item => ({
            id: workspaceKey(item),
            name: item.name,
            path: item.uri.fsPath,
          })),
        });
      }
    }
  }

  const refresh = (uri: vscode.Uri) => {
    if (
      panel?.visible &&
      !busy &&
      folder &&
      uri.fsPath === path.join(folder.uri.fsPath, settingsFile)
    ) {
      void snapshot();
    }
  };

  function selectFolder(next: vscode.WorkspaceFolder) {
    if (folder && workspaceKey(folder) === workspaceKey(next)) return;
    folder = next;
    sourceWatch?.dispose();
    sourceWatch = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(next, settingsFile.split(path.sep).join('/'))
    );
    sourceWatch.onDidChange(refresh);
    sourceWatch.onDidCreate(refresh);
    sourceWatch.onDidDelete(refresh);
  }

  function inWorkspace(
    uri: vscode.Uri | undefined,
    local: vscode.WorkspaceFolder
  ): string | undefined {
    if (
      uri?.scheme === 'file' &&
      /\.pyw?$/i.test(uri.fsPath) &&
      vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === workspaceKey(local)
    ) {
      return scriptKey(local.uri.fsPath, uri.fsPath);
    }
  }

  async function handle(message: unknown) {
    if (!isRecord(message) || typeof message.type !== 'string' || !folder) return;
    if (message.type === 'ready') {
      ready = true;
      await snapshot(true, initial);
      return;
    }
    if (message.type === 'resizeColumns') {
      const widths = readConfigurationColumnWidths(message.widths);
      await context.globalState.update(columnWidthsKey, widths).then(undefined, () => {});
      return;
    }
    if (message.type === 'setLanguage' && isConfigurationLanguageMode(message.mode)) {
      const owner = panel;
      let error: string | undefined;
      try {
        await context.globalState.update(
          languageKey,
          message.mode === 'auto' ? undefined : message.mode
        );
      } catch {
        error = 'Could not save the interface language.';
      }
      if (owner && panel === owner) {
        const current = language();
        owner.title = configurationText(current.locale, panelTitle);
        send({ type: 'language', ...current, error });
      }
      return;
    }
    if (!ready || busy) return;
    if (message.type === 'close' && workspaceKey(folder) === message.folder) {
      panel?.dispose();
      return;
    }
    if (message.type === 'navigate' || message.type === 'reload') {
      const next = folders().find(item => workspaceKey(item) === message.folder);
      if (!next) {
        send({ type: 'error', error: 'The project is no longer in this workspace.' });
        return;
      }
      const same = workspaceKey(folder) === workspaceKey(next);
      currentScript =
        typeof message.script === 'string' &&
        /\.pyw?$/i.test(message.script) &&
        isLocalPathAtOrUnder(next.uri.fsPath, path.resolve(next.uri.fsPath, message.script))
          ? message.script
          : same
            ? currentScript
            : undefined;
      selectFolder(next);
      await snapshot(true, focusFor(message.focus));
      return;
    }
    if (
      ![
        'apply',
        'browse',
        'testSsh',
        'testPython',
        'discoverPython',
        'openJson',
        'sshAliases',
      ].includes(message.type)
    ) {
      return;
    }
    if (
      workspaceKey(folder) !== message.folder ||
      !folders().some(item => workspaceKey(item) === message.folder)
    ) {
      send({
        type: 'error',
        error: 'The project is no longer selected. Reload the configuration editor.',
      });
      return;
    }
    const owner = panel;
    const workspace = folder.uri.fsPath;
    if (message.type === 'sshAliases') {
      const { request, configPath } = message;
      if (
        message.section !== 'servers' ||
        !Number.isSafeInteger(request) ||
        typeof configPath !== 'string' ||
        configPath.length > 4096 ||
        /[\r\n\0]/.test(configPath)
      ) {
        return;
      }
      try {
        trusted();
        send({
          type: 'sshAliases',
          request,
          aliases: sshHostAliases(workspace, configPath.trim()),
        });
      } catch (error) {
        send({ type: 'sshAliases', request, ...safeError(error) });
      }
      return;
    }
    let settings: Settings | undefined;
    busy = true;
    try {
      trusted();
      if (message.type === 'openJson') {
        await configure(folder);
        return;
      }
      if (message.type === 'browse') {
        const field = message.field;
        const directory = field === 'cwd' || field === 'context';
        const workspaceFile = field === 'program';
        if (
          typeof field !== 'string' ||
          !['cwd', 'context', 'program', 'privateKeyPath', 'sshConfigPath', 'ignoreFile'].includes(
            field
          )
        ) {
          return;
        }
        const [picked] =
          (await vscode.window.showOpenDialog({
            defaultUri: folder.uri,
            canSelectFiles: !directory,
            canSelectFolders: directory,
            canSelectMany: false,
            filters: workspaceFile ? { Python: ['py', 'pyw'] } : undefined,
          })) ?? [];
        if (picked && panel === owner) {
          const inside = isLocalPathAtOrUnder(workspace, picked.fsPath);
          if ((directory || workspaceFile) && !inside) {
            throw new Error('Choose a path inside this workspace.');
          }
          send({
            type: 'browse',
            field,
            value: inside ? scriptKey(workspace, picked.fsPath) || '.' : picked.fsPath,
          });
        }
        return;
      }
      const source = await sourceFor(folder);
      settings = source.settings;
      if (message.revision !== source.revision) {
        throw new Error('runhop.json changed. Reload before applying or testing your draft.');
      }
      const { key, section } = message;
      if (
        typeof key !== 'string' ||
        key.length > 1024 ||
        !sections.includes(section as ConfigurationSection)
      ) {
        throw new Error('Invalid configuration selection.');
      }
      const fields = requireFields(message.fields);
      if (message.type === 'apply') {
        const result = await configurationEdits(settings, workspace, currentScript, {
          section: section as ConfigurationSection,
          key,
          fields,
          copyFrom:
            key === 'new' && typeof message.copyFrom === 'string' ? message.copyFrom : undefined,
          remove: message.remove === true,
        });
        if (!panel || panel !== owner) return;
        if (result.edits.length) await updateSettings(folder, () => result.edits, source.text);
        if (panel === owner) {
          await snapshot(true, { section: section as ConfigurationSection, key: result.key }, true);
        }
      } else if (message.type === 'testSsh' && section === 'servers') {
        const { raw } = makeServer(settings, key, fields);
        const result = await testConfigurationServer(workspace, raw);
        if (panel === owner) send({ type: 'probe', kind: 'ssh', ...result });
      } else if (
        (message.type === 'testPython' || message.type === 'discoverPython') &&
        section === 'interpreters'
      ) {
        const discover = message.type === 'discoverPython';
        const entry = makeInterpreter(settings, discover ? { ...fields, path: 'python3' } : fields);
        let anchor = currentScript ? path.resolve(workspace, currentScript) : workspace;
        if (entry.target) {
          const target = settings.targets.find(target => target.name === entry.target);
          anchor = path.resolve(
            workspace,
            typeof target?.context === 'string' ? target.context : '.'
          );
        }
        const result = await checkConfigurationPython(settings, workspace, anchor, entry, discover);
        if (panel === owner) {
          send({ type: 'probe', kind: discover ? 'discover' : 'python', ...result });
        }
      }
    } catch (error) {
      if (panel === owner) send({ type: 'error', ...safeError(error, settings) });
    } finally {
      if (panel === owner) {
        busy = false;
        send({ type: 'done' });
      }
    }
  }

  async function show(requested?: unknown, focus?: unknown, script?: unknown) {
    const { mode, locale } = language();
    try {
      trusted();
      const uri =
        script instanceof vscode.Uri ? script : vscode.window.activeTextEditor?.document.uri;
      const choices = folders();
      const selected =
        requested instanceof vscode.Uri
          ? vscode.workspace.getWorkspaceFolder(requested)
          : choices.find(
              item =>
                isRecord(requested) &&
                requested.uri instanceof vscode.Uri &&
                workspaceKey(item) === requested.uri.toString()
            );
      const active = uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
      const open =
        selected ??
        active ??
        folder ??
        (choices.length === 1
          ? choices[0]
          : await vscode.window.showWorkspaceFolderPick({
              placeHolder: configurationText(locale, 'Choose a RunHop project'),
            }));
      if (!open || open.uri.scheme !== 'file') {
        if (!choices.length) throw new Error('Open a local project folder first.');
        return;
      }
      const nextScript = inWorkspace(uri, open);
      if (panel) {
        const wasActive = panel.active;
        panel.reveal(undefined, false);
        if (
          focus ||
          !folder ||
          workspaceKey(open) !== workspaceKey(folder) ||
          (nextScript && nextScript !== currentScript)
        ) {
          send({
            type: 'navigate',
            folder: workspaceKey(open),
            script: nextScript,
            focus: focusFor(focus),
          });
        } else if (wasActive && !busy) {
          await snapshot();
        }
        return;
      }
      initial = focusFor(focus);
      currentScript = nextScript;
      const title = configurationText(locale, panelTitle);
      const widths = readConfigurationColumnWidths(context.globalState.get(columnWidthsKey));
      const view = vscode.window.createWebviewPanel(
        'runhop.configurations',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] }
      );
      panel = view;
      selectFolder(open);
      view.iconPath = new vscode.ThemeIcon('list-tree');
      const resource = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, name));
      const nonce = randomBytes(18).toString('base64');
      const receiver = view.webview.onDidReceiveMessage(value => {
        void handle(value);
      });
      const visibility = view.onDidChangeViewState(() => {
        if (panel === view && view.active && !busy) void snapshot();
      });
      view.onDidDispose(() => {
        receiver.dispose();
        visibility.dispose();
        if (panel === view) {
          panel = undefined;
          folder = undefined;
          sourceWatch?.dispose();
          sourceWatch = undefined;
          ready = false;
          busy = false;
          revisionCounter++;
        }
      });
      view.webview.html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('configurations.css')}">
<title>${title}</title>
</head>
<body>
<main id="configurations" data-language-mode="${mode}" data-categories-width="${widths.categories}" data-entries-width="${widths.entries}"></main>
<script nonce="${nonce}" src="${resource('configurations.js')}"></script>
</body>
</html>`;
    } catch (error) {
      const failure = safeError(error);
      void vscode.window.showErrorMessage(
        'RunHop: ' + (locale === 'zh-CN' ? failure.errorZh : failure.error)
      );
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('runhop.configurations', show),
    { dispose: () => panel?.dispose() },
    vscode.workspace.onDidSaveTextDocument(document => refresh(document.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (panel?.visible && !busy) void snapshot();
    })
  );

  return () => {
    if (
      panel?.active &&
      folder &&
      folders().some(item => workspaceKey(item) === workspaceKey(folder!))
    ) {
      return { folder, script: currentScript };
    }
  };
}
