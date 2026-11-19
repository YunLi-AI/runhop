import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BreakpointStatus } from './breakpointSession';
import type { TerminalPanel } from './terminal';

type NativeBreakpoint = vscode.SourceBreakpoint | vscode.FunctionBreakpoint;

interface SessionDetails {
  id: string;
  name: string;
  muted: boolean;
  functions?: boolean;
  condition?: boolean;
  hitCondition?: boolean;
  logMessage?: boolean;
  status(point: NativeBreakpoint): BreakpointStatus | undefined;
  exceptions: { filter: string; label: string; description?: string; enabled?: boolean }[];
  exceptionOverride?: boolean;
  setException?(id: string, enabled: boolean): Promise<void>;
}

function locationKey(bp: NativeBreakpoint): string {
  if (bp instanceof vscode.FunctionBreakpoint) {
    return JSON.stringify(['function', bp.functionName]);
  }
  const { uri, range } = bp.location;
  return JSON.stringify([uri.toString(), range.start.line, range.start.character]);
}

function nativeBreakpoints(): NativeBreakpoint[] {
  return vscode.debug.breakpoints.filter(
    bp => bp instanceof vscode.SourceBreakpoint || bp instanceof vscode.FunctionBreakpoint
  );
}

function properties(bp: NativeBreakpoint) {
  return {
    enabled: bp.enabled,
    condition: bp.condition ?? '',
    hitCondition: bp.hitCondition ?? '',
    logMessage: bp.logMessage ?? '',
  };
}

function rowFor(bp: NativeBreakpoint, session?: SessionDetails) {
  const status = bp.enabled && !session?.muted ? session?.status(bp) : undefined;
  const row = {
    id: bp.id,
    key: locationKey(bp),
    ...properties(bp),
    verified: status?.verified,
    resolvedLine: status?.line,
    message: status?.message,
    supported: true,
    group: '',
    directory: '',
    workspace: '',
    line: 0,
    column: 0,
  };
  if (bp instanceof vscode.FunctionBreakpoint) {
    return {
      ...row,
      kind: 'function',
      file: bp.functionName,
      supported: session?.functions !== false,
    };
  }
  const { uri, range } = bp.location;
  const file = uri.fsPath;
  const workspace = vscode.workspace.getWorkspaceFolder(uri);
  const directory = workspace
    ? path.dirname(path.relative(workspace.uri.fsPath, file))
    : path.dirname(file);
  return {
    ...row,
    kind: 'line',
    group: uri.toString(),
    file: path.basename(file) || uri.toString(),
    directory: directory === '.' ? '' : directory,
    workspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? (workspace?.name ?? '') : '',
    line: range.start.line + 1,
    column: range.start.character,
  };
}

type Row = ReturnType<typeof rowFor>;

function label(row: Row): string {
  return row.kind === 'line' ? row.file + ':' + row.line : row.file;
}

function statusLabel(row: Row, session?: SessionDetails): string {
  if (!row.enabled) return 'Disabled';
  if (session?.muted) return 'Muted';
  if (!row.supported) return 'Unavailable in this session';
  if (row.verified !== undefined) return row.verified ? 'Verified' : 'Unverified';
  return session ? 'Pending verification' : 'Enabled';
}

export class BreakpointsManager implements vscode.Disposable {
  private view?: vscode.WebviewPanel;
  private editor?: vscode.TextEditor;
  private selected?: string;
  private selectionRevision = 0;
  private lastSnapshot = '';
  private summary = '';
  private ready = false;
  private busy = false;
  private notice?: { text: string; error?: boolean };
  private removed?: NativeBreakpoint;
  private quickPick?: vscode.QuickPick<vscode.QuickPickItem & { id?: string }>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: TerminalPanel,
    private readonly currentSession: () => SessionDetails | undefined
  ) {
    this.rememberEditor(vscode.window.activeTextEditor);
    context.subscriptions.push(
      this,
      vscode.commands.registerCommand('runhop.breakpoints', () => this.show(true)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        this.rememberEditor(editor);
        this.publish();
      }),
      vscode.debug.onDidChangeBreakpoints(() => queueMicrotask(() => this.publish())),
      panel.onBreakpointIntent(value => {
        if (value === 'open') this.show(true);
        if (value === 'quick') this.showQuickList();
      })
    );
  }

  private rememberEditor(editor?: vscode.TextEditor): void {
    if (editor && editor.document.languageId === 'python') this.editor = editor;
  }

  private choose(bp: NativeBreakpoint): void {
    this.selected = locationKey(bp);
    this.selectionRevision++;
  }

  private pointAtCursor(): vscode.SourceBreakpoint | undefined {
    const editor = this.editor;
    if (!editor || editor.document.isClosed) return undefined;
    const line = editor.selection.active.line;
    return nativeBreakpoints().find(
      bp =>
        bp instanceof vscode.SourceBreakpoint &&
        bp.location.uri.toString() === editor.document.uri.toString() &&
        bp.location.range.start.line === line
    ) as vscode.SourceBreakpoint | undefined;
  }

  private show(fromCursor = false): void {
    if (fromCursor) {
      this.rememberEditor(vscode.window.activeTextEditor);
      const atCursor = this.pointAtCursor();
      if (atCursor && (!this.view || vscode.window.activeTextEditor)) this.choose(atCursor);
    }
    if (this.view) {
      this.view.reveal(undefined, false);
      this.publish();
      return;
    }

    const root = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const view = vscode.window.createWebviewPanel(
      'runhop.breakpointManager',
      'RunHop Breakpoints',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true }
    );
    this.view = view;
    view.iconPath = new vscode.ThemeIcon('debug-breakpoint');
    const uri = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, name));
    const nonce = randomBytes(18).toString('base64');
    const subscription = view.webview.onDidReceiveMessage(value => {
      if (this.view === view) void this.handle(value);
    });
    const visibility = view.onDidChangeViewState(() => this.publish());
    view.onDidDispose(() => {
      subscription.dispose();
      visibility.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        this.lastSnapshot = '';
        this.notice = undefined;
        this.removed = undefined;
      }
    });
    view.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${uri('breakpoints.css')}">
<title>RunHop Breakpoints</title>
</head>
<body>
<main id="breakpoint-manager"></main>
<script nonce="${nonce}" src="${uri('breakpoints.js')}"></script>
</body>
</html>`;
  }

  publish(): void {
    const points = nativeBreakpoints();
    const session = this.currentSession();
    const rows =
      this.view?.visible || this.quickPick
        ? points
            .map(bp => rowFor(bp, session))
            .sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) ||
                a.workspace.localeCompare(b.workspace) ||
                a.directory.localeCompare(b.directory) ||
                a.file.localeCompare(b.file) ||
                a.line - b.line ||
                a.column - b.column
            )
        : [];
    const total = points.length;
    const enabled = points.filter(bp => bp.enabled).length;
    const summary = JSON.stringify({ total, enabled, muted: session?.muted ?? false });
    if (summary !== this.summary) {
      this.summary = summary;
      this.panel.showBreakpointSummary({ total, enabled, muted: session?.muted ?? false });
    }
    if (this.quickPick) {
      this.quickPick.items = rows.map(row => ({
        id: row.id,
        label: label(row),
        description: statusLabel(row, session),
        detail: row.directory || undefined,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon(row.enabled ? 'circle-slash' : 'check'),
            tooltip: row.enabled ? 'Disable breakpoint' : 'Enable breakpoint',
          },
        ],
      }));
    }
    if (!this.view?.visible || !this.ready) return;
    const state = {
      rows,
      selected: this.selected,
      selectionRevision: this.selectionRevision,
      session: session?.name,
      sessionId: session?.id,
      muted: session?.muted,
      functions: session?.functions,
      condition: session?.condition,
      hitCondition: session?.hitCondition,
      logMessage: session?.logMessage,
      exceptions: session?.exceptions ?? [],
      canSetException: Boolean(session?.setException) && !this.busy,
      exceptionOverride: session?.exceptionOverride,
      canAddLine: Boolean(this.editor && !this.editor.document.isClosed),
      notice: this.notice,
      canUndo: Boolean(this.removed),
    };
    const snapshot = JSON.stringify(state);
    if (snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      void this.view.webview.postMessage({ type: 'state', state });
    }
  }

  private showQuickList(): void {
    if (this.quickPick) return;
    if (!nativeBreakpoints().length) {
      this.show();
      return;
    }
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { id?: string }>();
    pick.title = 'RunHop · Quick Breakpoints';
    pick.placeholder =
      'Select a breakpoint to go to source. Use its button to enable or disable it.';
    pick.matchOnDescription = pick.matchOnDetail = true;
    this.quickPick = pick;
    pick.onDidTriggerItemButton(({ item }) => {
      const point = nativeBreakpoints().find(bp => bp.id === item.id);
      if (point) this.toggle(point);
    });
    pick.onDidAccept(() => {
      const point = nativeBreakpoints().find(bp => bp.id === pick.selectedItems[0]?.id);
      pick.hide();
      if (point instanceof vscode.SourceBreakpoint) {
        void this.showSource(point, false).catch(error =>
          vscode.window.showErrorMessage(error.message)
        );
      } else if (point) {
        this.choose(point);
        this.show();
      }
    });
    pick.onDidHide(() => {
      this.quickPick = undefined;
      pick.dispose();
    });
    this.publish();
    pick.show();
  }

  private toggle(bp: NativeBreakpoint): void {
    this.replace(bp, { ...properties(bp), enabled: !bp.enabled });
    this.publish();
  }

  sourceColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
    if (!this.view?.visible) {
      return undefined;
    }
    const editors = vscode.window.visibleTextEditors.filter(
      editor => editor.viewColumn !== this.view?.viewColumn
    );
    const matching = editors.find(editor => editor.document.uri.toString() === uri.toString());
    return matching?.viewColumn ?? editors[0]?.viewColumn ?? vscode.ViewColumn.Beside;
  }

  private async showSource(bp: vscode.SourceBreakpoint, preserveFocus: boolean): Promise<void> {
    const editor = await vscode.window.showTextDocument(bp.location.uri, {
      selection: bp.location.range,
      preview: true,
      preserveFocus,
      viewColumn: this.sourceColumn(bp.location.uri),
    });
    this.rememberEditor(editor);
  }

  private async add(kind: unknown): Promise<void> {
    if (kind === 'function') {
      if (!this.currentSession()?.functions) {
        throw new Error('The selected adapter does not support function breakpoints.');
      }
      const name = (
        await vscode.window.showInputBox({
          title: 'Add Function Breakpoint',
          prompt: 'Python function name',
        })
      )?.trim();
      if (!name) return;
      const existing = nativeBreakpoints().find(
        bp => bp instanceof vscode.FunctionBreakpoint && bp.functionName === name
      );
      const point = existing ?? new vscode.FunctionBreakpoint(name);
      this.choose(point);
      if (!existing) vscode.debug.addBreakpoints([point]);
      this.notice = { text: existing ? 'Breakpoint selected.' : 'Function breakpoint added.' };
      return;
    }

    const editor = this.editor;
    if (!editor || editor.document.isClosed) {
      throw new Error('Open a Python file and place the cursor on the target line.');
    }
    const existing = this.pointAtCursor();
    const point =
      existing ??
      new vscode.SourceBreakpoint(
        new vscode.Location(
          editor.document.uri,
          new vscode.Position(editor.selection.active.line, 0)
        )
      );
    this.choose(point);
    if (!existing) vscode.debug.addBreakpoints([point]);
    this.notice = { text: existing ? 'Breakpoint selected.' : 'Breakpoint added.' };
  }

  private async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const { action, id, input, sessionId } = message as Record<string, unknown>;
    if (action === 'ready') {
      this.ready = true;
      this.lastSnapshot = '';
      this.publish();
      return;
    }
    if (action === 'close') {
      this.view?.dispose();
      return;
    }
    if (this.busy) return;
    this.notice = undefined;
    this.busy = true;
    try {
      if (action === 'exceptions') {
        await vscode.commands.executeCommand('workbench.view.debug');
        if (
          (await vscode.commands.getCommands()).includes('workbench.debug.breakPointsView.focus')
        ) {
          await vscode.commands.executeCommand('workbench.debug.breakPointsView.focus');
        }
      } else if (action === 'exception') {
        const session = this.currentSession();
        if (
          !session?.setException ||
          session.id !== sessionId ||
          typeof id !== 'string' ||
          typeof input !== 'boolean' ||
          !session.exceptions.some(filter => filter.filter === id)
        ) {
          throw new Error('Select an active RunHop debug session to change its exception filters.');
        }
        this.publish();
        await session.setException(id, input);
        this.notice = { text: 'Exception filter updated for ' + session.name + '.' };
      } else if (action === 'add') {
        await this.add(input);
      } else if (action === 'undo') {
        const point = this.removed;
        if (point) {
          if (nativeBreakpoints().some(bp => locationKey(bp) === locationKey(point))) {
            throw new Error('A breakpoint already exists at that location.');
          }
          this.removed = undefined;
          vscode.debug.addBreakpoints([point]);
          this.choose(point);
          this.notice = { text: 'Breakpoint restored.' };
        }
      } else {
        const bp = nativeBreakpoints().find(point => point.id === id);
        if (!bp) throw new Error('The breakpoint changed in VS Code. Select it again to continue.');
        if (action === 'source' && bp instanceof vscode.SourceBreakpoint) {
          await this.showSource(bp, true);
        } else if (action === 'remove') {
          vscode.debug.removeBreakpoints([bp]);
          this.removed = bp;
          this.notice = { text: 'Breakpoint removed.' };
        } else if (action === 'toggle') {
          this.toggle(bp);
          this.notice = { text: bp.enabled ? 'Breakpoint disabled.' : 'Breakpoint enabled.' };
        } else if (action === 'apply') {
          this.replace(bp, this.readProperties(input));
          this.notice = { text: 'Breakpoint properties saved.' };
        }
      }
    } catch (error) {
      this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private replace(bp: NativeBreakpoint, next: ReturnType<typeof properties>): void {
    const original = properties(bp);
    if (Object.keys(next).every(key => next[key] === original[key])) return;
    const args = [
      next.enabled,
      next.condition || undefined,
      next.hitCondition || undefined,
      next.logMessage || undefined,
    ] as const;
    const replacement =
      bp instanceof vscode.SourceBreakpoint
        ? new vscode.SourceBreakpoint(bp.location, ...args)
        : new vscode.FunctionBreakpoint(bp.functionName, ...args);
    vscode.debug.removeBreakpoints([bp]);
    vscode.debug.addBreakpoints([replacement]);
  }

  private readProperties(input: unknown): ReturnType<typeof properties> {
    if (!input || typeof input !== 'object') throw new Error('Invalid breakpoint properties.');
    const { enabled, condition, hitCondition, logMessage } = input as Record<string, unknown>;
    if (
      typeof enabled !== 'boolean' ||
      typeof condition !== 'string' ||
      typeof hitCondition !== 'string' ||
      typeof logMessage !== 'string' ||
      [condition, hitCondition, logMessage].some(
        value => value.length > 6000 || value.includes('\0')
      )
    ) {
      throw new Error('Invalid breakpoint properties.');
    }
    return { enabled, condition: condition.trim(), hitCondition: hitCondition.trim(), logMessage };
  }

  dispose(): void {
    this.quickPick?.dispose();
    this.view?.dispose();
  }
}
