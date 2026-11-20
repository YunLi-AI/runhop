import { randomBytes } from 'crypto';
import { stripVTControlCharacters } from 'util';
import * as vscode from 'vscode';
import { Execution, Outcome, SessionPhase, formatPhase } from './sessionState';
import { settingsFile } from './settings';

export const terminalViewId = 'runhop.terminal';
const historyLimit = 512 * 1024;

interface ShellChannel {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export class SessionTerminal {
  history = '';
  finished = false;
  shell?: ShellChannel;
  ready = false;
  phase: SessionPhase = 'Starting';
  outcome?: Outcome;
  pid?: number;
  execution?: Execution;
  activity?: string;
  restarting = false;
  private complete!: (outcome: Outcome) => void;
  readonly completion = new Promise<Outcome>(resolve => (this.complete = resolve));
  private lastCharacter = '';

  constructor(
    readonly id: number,
    readonly name: string,
    readonly interactive: boolean,
    readonly debugSession: string | undefined,
    private readonly changed: (output?: string, focus?: boolean, outcome?: Outcome) => void
  ) {}

  write(value: string, raw = false): void {
    if (this.finished || !value) {
      return;
    }
    const normalized = raw ? value : value.replace(/(?<!\r)\n/g, '\r\n');
    const data =
      !raw && this.lastCharacter === '\r' && value.startsWith('\n')
        ? normalized.slice(1)
        : normalized;
    this.lastCharacter = value.slice(-1);
    this.history = (this.history + data).slice(-historyLimit);
    this.changed(data);
  }

  attach(shell: ShellChannel): boolean {
    if (this.finished) {
      shell.close();
      return false;
    }
    this.shell = shell;
    return true;
  }

  markReady(): void {
    if (!this.finished) {
      this.ready = true;
      this.phase = 'Running';
      this.changed(undefined, true);
    }
  }

  update(phase: SessionPhase, pid?: number): void {
    if (!this.finished && (phase !== this.phase || (pid !== undefined && pid !== this.pid))) {
      this.phase = phase;
      if (phase !== 'Starting') {
        this.activity = undefined;
      }
      this.pid = pid ?? this.pid;
      this.changed();
    }
  }

  showActivity(activity?: string): void {
    if ((this.phase === 'Starting' || this.finished) && activity !== this.activity) {
      this.activity = activity;
      this.changed();
    }
  }

  refresh(): void {
    this.changed();
  }

  finish(outcome: Outcome = { phase: 'Exited' }): void {
    if (!this.finished) {
      this.finished = true;
      this.phase = outcome.phase;
      this.activity = undefined;
      this.outcome = outcome;
      this.shell = undefined;
      if (this.execution) {
        this.execution.stop = undefined;
        this.execution.input = undefined;
      }
      this.changed(undefined, undefined, outcome);
      this.complete(outcome);
    }
  }

  close(): void {
    this.shell?.close();
    this.finish();
  }
}

export class TerminalPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly sessions = new Map<number, SessionTerminal>();
  private readonly reruns = new Map<string, SessionTerminal>();
  private sequence = 0;
  private active?: SessionTerminal;
  private view?: vscode.WebviewView;
  private output = '';
  private flushTimer?: NodeJS.Timeout;
  private debuggerState: unknown = null;
  private breakpointSummary = { total: 0, enabled: 0, muted: false };
  private readonly selection = new vscode.EventEmitter<string | undefined>();
  private readonly intent = new vscode.EventEmitter<unknown>();
  private readonly breakpointIntent = new vscode.EventEmitter<'open' | 'quick'>();
  private readonly settled = new vscode.EventEmitter<{ id: string; outcome: Outcome }>();
  private readonly removed = new vscode.EventEmitter<string>();
  readonly onDidSelectDebugSession = this.selection.event;
  readonly onDebuggerIntent = this.intent.event;
  readonly onBreakpointIntent = this.breakpointIntent.event;
  readonly onDidFinishDebugSession = this.settled.event;
  readonly onDidRemoveDebugSession = this.removed.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  create(
    name: string,
    interactive = false,
    debugSession?: string,
    execution?: Execution,
    rerunToken?: unknown
  ): SessionTerminal {
    const previous = typeof rerunToken === 'string' ? this.reruns.get(rerunToken) : undefined;
    const replacement =
      previous &&
      execution &&
      previous.finished &&
      !interactive &&
      previous.execution?.workspace === execution.workspace &&
      Boolean(previous.debugSession) === Boolean(debugSession) &&
      this.sessions.get(previous.id) === previous
        ? previous
        : undefined;
    const session = new SessionTerminal(
      replacement?.id ?? ++this.sequence,
      replacement?.name ?? name,
      interactive,
      debugSession,
      (output, focus, outcome) => {
        if (this.sessions.get(session.id) !== session) {
          return;
        }
        if (output === undefined) {
          if (session === this.active) {
            this.snapshot(focus, false);
          } else {
            this.publishSessions();
          }
          if (outcome && session.debugSession) {
            this.settled.fire({ id: session.debugSession, outcome });
          }
        } else if (session === this.active && this.view?.visible) {
          this.output = (this.output + output).slice(-historyLimit);
          this.flushTimer ??= setTimeout(() => this.flush(), 16);
        }
      }
    );
    session.execution = execution;
    if (replacement) {
      this.reruns.delete(rerunToken as string);
      if (execution) {
        execution.configurationFile = replacement.execution?.configurationFile;
      }
      if (replacement.history) {
        session.history = replacement.history;
        session.write(debugSession ? '\n[RunHop] Restart\n' : '\n[RunHop] Rerun\n');
      }
    }
    this.sessions.set(session.id, session);
    if (!replacement || this.active === replacement) {
      this.activate(session);
    } else {
      this.publishSessions();
    }
    if (replacement) {
      if (replacement.debugSession) {
        this.removed.fire(replacement.debugSession);
      }
      return session;
    }
    if (this.view) {
      this.view.show(!interactive);
    } else {
      void vscode.commands.executeCommand(terminalViewId + '.focus', {
        preserveFocus: !interactive,
      });
    }
    return session;
  }

  updateDebugSession(id: string, phase: SessionPhase, pid?: number): void {
    const session = this.debugTerminal(id);
    if (session) {
      session.update(session.phase === 'Stopping' ? 'Stopping' : phase, pid);
    }
  }

  selectedExecution(workspace?: string): Execution | undefined {
    const execution = this.active?.execution;
    return execution?.stop &&
      !this.active?.restarting &&
      (workspace === undefined || workspace === execution.workspace)
      ? execution
      : undefined;
  }

  async stopSelected(expectedId?: string): Promise<void> {
    const session = this.active;
    const stop = session?.execution?.stop;
    if (
      !session ||
      !stop ||
      session.finished ||
      session.restarting ||
      session.phase === 'Stopping' ||
      (expectedId !== undefined && session.execution?.id !== expectedId)
    ) {
      return;
    }
    const previous = session.phase;
    session.update('Stopping');
    try {
      await stop();
    } catch (error) {
      session.update(previous);
      void vscode.window.showErrorMessage(
        'RunHop: Could not stop ' + session.name + '. ' + error.message
      );
    }
  }

  private async rerun(session: SessionTerminal): Promise<void> {
    const { stop, rerun } = session.execution ?? {};
    if (
      !rerun ||
      session.phase === 'Disconnected' ||
      session.phase === 'Stopping' ||
      session.phase === 'Starting' ||
      session.restarting
    ) {
      return;
    }
    const phase = session.phase;
    const token = randomBytes(16).toString('hex');
    session.restarting = true;
    session.refresh();
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (!session.finished && stop) {
        session.update('Stopping');
        const outcome = await Promise.race([
          stop().then(() => session.completion),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('The previous session did not stop.')),
              10_000
            );
          }),
        ]);
        if (outcome.phase === 'Disconnected') {
          throw new Error('RunHop could not confirm that the previous process stopped.');
        }
      }
      this.reruns.set(token, session);
      await rerun(token);
    } catch (error) {
      if (!session.finished) {
        session.update(phase);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.reruns.delete(token);
      session.restarting = false;
      session.refresh();
    }
  }

  private debugTerminal(id: string): SessionTerminal | undefined {
    return [...this.sessions.values()].find(entry => entry.debugSession === id);
  }

  writeDebugOutput(id: string, output: string): void {
    this.debugTerminal(id)?.write(output);
  }

  debugOutput(id: string): string {
    return this.debugTerminal(id)?.history ?? '';
  }

  clearDebugOutput(id: string): void {
    const session = this.debugTerminal(id);
    if (session) {
      session.history = '';
      if (this.active === session) {
        this.snapshot();
      }
    }
  }

  showDebugger(state: unknown): void {
    this.debuggerState = state;
    if (this.view?.visible) {
      void this.view.webview.postMessage({ type: 'debugger', state });
    }
  }

  showBreakpointSummary(summary: { total: number; enabled: number; muted: boolean }): void {
    this.breakpointSummary = summary;
    if (this.view?.visible) {
      void this.view.webview.postMessage({ type: 'breakpointSummary', summary });
    }
  }

  private activate(session?: SessionTerminal): void {
    const oldDebugSession = this.active?.debugSession;
    this.active = session;
    if (oldDebugSession !== session?.debugSession) {
      this.selection.fire(session?.debugSession);
    }
    this.snapshot(Boolean(session?.ready));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assets = vscode.Uri.joinPath(this.extensionUri, 'resources');
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [assets] };
    const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, name));
    const nonce = randomBytes(18).toString('base64');
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('terminal.css')}">
  <title>RunHop Terminal</title>
</head>
<body>
  <div id="execution-bar" hidden>
    <div id="execution-tabs" role="tablist" aria-label="RunHop sessions"></div>
    <button id="execution-new" type="button" aria-label="New RunHop session" title="New RunHop session">+</button>
  </div>
  <div id="execution-controls" hidden></div>
  <div id="debugger" hidden></div>
  <div id="debug-drawer" hidden></div>
  <div id="empty">
    <p>No RunHop session is open.</p>
    <button type="button" data-action="run">Run Python</button>
    <button type="button" data-action="debug">Debug Python</button>
    <button type="button" data-action="shell">Open Terminal on Server</button>
  </div>
  <div id="terminal" hidden></div>
  <form id="program-input" hidden>
    <input type="text" id="program-line" aria-label="Program input" placeholder="Program input" maxlength="4096" autocomplete="off">
    <button type="submit">Send</button>
    <button type="button" id="program-eof" title="Close standard input">Send EOF</button>
  </form>
  <script nonce="${nonce}" src="${uri('terminal.js')}"></script>
</body>
</html>`;
    const subscriptions = [
      webview.onDidReceiveMessage(message => this.receive(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.snapshot();
        }
      }),
    ];
    view.onDidDispose(() => {
      subscriptions.forEach(subscription => subscription.dispose());
      if (this.view === view) {
        this.view = undefined;
        this.clearFlush();
      }
    });
  }

  private receive(message: {
    type: string;
    id?: number;
    executionId?: string;
    data?: string;
    cols?: number;
    rows?: number;
    intent?: unknown;
    action?: string;
  }): void {
    const session = this.active;
    if (!message) {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.snapshot(Boolean(session?.ready));
        break;
      case 'debugger':
        if (session?.debugSession) {
          this.intent.fire(message.intent);
        }
        break;
      case 'breakpoints':
        if (message.action === 'open' || message.action === 'quick') {
          this.breakpointIntent.fire(message.action);
        }
        break;
      case 'selectSession': {
        const selection = this.sessions.get(message.id ?? -1);
        if (selection) {
          this.activate(selection);
        }
        break;
      }
      case 'stopSession':
        if (session && message.id === session.id && message.executionId === session.execution?.id) {
          void this.stopSelected();
        }
        break;
      case 'rerunSession':
        if (session && message.id === session.id && message.executionId === session.execution?.id) {
          void this.rerun(session).catch(error => this.showError(error));
        }
        break;
      case 'programInput':
      case 'programEof':
        if (
          session?.phase === 'Running' &&
          message.id === session.id &&
          message.executionId === session.execution?.id &&
          session.execution?.input
        ) {
          if (message.type === 'programEof') {
            session.execution.input(null);
          } else if (
            typeof message.data === 'string' &&
            message.data.length <= 4096 &&
            !/[\r\n]/.test(message.data)
          ) {
            session.execution.input(message.data);
          }
        }
        break;
      case 'closeSession': {
        const target = this.sessions.get(message.id ?? -1);
        if (
          target &&
          message.executionId === target.execution?.id &&
          (target.finished || (target.interactive && target === session))
        ) {
          this.closeSession(target);
        }
        break;
      }
      case 'newSession':
        void this.newSession().catch(error => this.showError(error));
        break;
      case 'editConfiguration': {
        const execution = session?.execution;
        if (execution?.workspace && execution.configurationFile && message.id === session?.id) {
          const uri = vscode.Uri.joinPath(
            vscode.Uri.parse(execution.workspace),
            ...execution.configurationFile.split(/[\\/]/)
          );
          void vscode.window.showTextDocument(uri, { preview: false }).then(undefined, error => {
            if (execution.configurationFile === settingsFile) {
              void vscode.commands.executeCommand('runhop.configure');
            } else {
              this.showError(error);
            }
          });
        }
        break;
      }
      case 'copyRunOutput':
        if (session?.execution && message.id === session.id) {
          void vscode.env.clipboard.writeText(stripVTControlCharacters(session.history));
        }
        break;
      case 'clearRunOutput':
        if (session?.execution && message.id === session.id) {
          session.history = '';
          this.snapshot();
        }
        break;
      case 'start':
        if (!session) {
          const commands = new Map([
            ['run', 'runhop.run'],
            ['debug', 'runhop.debug'],
            ['shell', 'runhop.openServerTerminal'],
          ]);
          const command = message.action && commands.get(message.action);
          if (command) {
            void vscode.commands.executeCommand(command);
          }
        }
        break;
      case 'input':
        if (
          session &&
          session.ready &&
          session.id === message.id &&
          typeof message.data === 'string' &&
          message.data.length <= 128 * 1024
        ) {
          session.shell?.input(message.data);
        }
        break;
      case 'resize':
        if (
          session &&
          session.id === message.id &&
          Number.isInteger(message.cols) &&
          Number.isInteger(message.rows) &&
          message.cols! >= 2 &&
          message.cols! <= 1000 &&
          message.rows! >= 1 &&
          message.rows! <= 1000
        ) {
          session.shell?.resize(message.cols!, message.rows!);
        }
        break;
    }
  }

  private showError(error: Error): void {
    void vscode.window.showErrorMessage('RunHop: ' + error.message);
  }

  private async newSession(): Promise<void> {
    const options = [
      { label: '$(play) Run Python', command: 'runhop.run' },
      { label: '$(debug-alt) Debug Python', command: 'runhop.debug' },
      { label: '$(terminal) Open Terminal on Server', command: 'runhop.openServerTerminal' },
      {
        label: '$(list-selection) Select Run Configuration',
        command: 'runhop.selectRunConfiguration',
      },
    ];
    const choice = await vscode.window.showQuickPick(options, { title: 'New RunHop Session' });
    if (choice) {
      await vscode.commands.executeCommand(choice.command);
    }
  }

  async select(): Promise<void> {
    const current = this.active;
    const close = { label: '$(close) Close Current Session', session: undefined };
    const choices = [...this.sessions.values()].reverse().map(session => ({
      label: session.name,
      description: session === current ? 'Current session' : undefined,
      detail: [formatPhase(session.phase, session.outcome?.code), session.execution?.host]
        .filter(Boolean)
        .join(' · '),
      session,
    }));
    const choice = await vscode.window.showQuickPick(
      [...choices, ...(current && (current.interactive || current.finished) ? [close] : [])],
      { title: 'RunHop · Terminal Sessions', placeHolder: 'Select a session to display' }
    );
    if (choice === close && this.active === current) {
      if (current) {
        this.closeSession(current);
      }
    } else if (choice?.session) {
      const session = this.sessions.get(choice.session.id);
      if (session) {
        this.activate(session);
      }
    }
  }

  private closeSession(session: SessionTerminal): void {
    if ((!session.interactive && !session.finished) || session.restarting) {
      return;
    }
    this.sessions.delete(session.id);
    session.close();
    if (session.debugSession) {
      this.removed.fire(session.debugSession);
    }
    if (session === this.active) {
      const previous = [...this.sessions.values()].reverse();
      this.activate(previous.find(entry => !entry.finished) ?? previous[0]);
    } else {
      this.publishSessions();
    }
  }

  private snapshot(focus = false, replay = true): void {
    if (replay) {
      this.clearFlush();
    }
    const active = this.active;
    if (this.view?.visible) {
      this.view.description = active?.name;
      void this.view.webview.postMessage({
        type: 'state',
        active: active && {
          id: active.id,
          executionId: active.execution?.id,
          ...(replay ? { history: active.history } : {}),
          writable: Boolean(active.ready && active.shell),
          canInput: Boolean(active.phase === 'Running' && active.execution?.input),
        },
        focus,
      });
      this.showDebugger(this.debuggerState);
      this.showBreakpointSummary(this.breakpointSummary);
      this.publishSessions();
    }
  }

  private publishSessions(): void {
    if (this.view?.visible) {
      const active = this.active;
      void this.view.webview.postMessage({
        type: 'sessions',
        sessions: [...this.sessions.values()].map(session => ({
          id: session.id,
          executionId: session.execution?.id,
          name: session.name,
          status: formatPhase(session.phase, session.outcome?.code),
          phase: session.phase,
          canClose:
            (session.finished || (session.interactive && session === active)) &&
            !session.restarting,
          detail: session.activity || session.outcome?.detail || session.execution?.program,
        })),
        active: active && {
          id: active.id,
          executionId: active.execution?.id,
          status: formatPhase(active.phase, active.outcome?.code),
          executable: Boolean(active.execution),
          debug: active.debugSession,
          canEdit: Boolean(active.execution?.workspace && active.execution.configurationFile),
          canStop:
            Boolean(active.execution?.stop) && active.phase !== 'Stopping' && !active.restarting,
          canRerun:
            Boolean(active.execution?.rerun) &&
            !['Disconnected', 'Stopping', 'Starting'].includes(active.phase) &&
            !active.restarting,
          activity: active.activity,
          detail: [
            active.execution?.host,
            active.execution?.program,
            active.execution?.python,
            active.execution?.cwd,
            active.pid && 'PID ' + active.pid,
            active.outcome?.detail,
          ]
            .filter(Boolean)
            .join(' · '),
        },
      });
    }
  }

  private flush(): void {
    const data = this.output;
    this.clearFlush();
    if (data && this.view?.visible && this.active) {
      void this.view.webview.postMessage({
        type: 'data',
        id: this.active.id,
        executionId: this.active.execution?.id,
        data,
      });
    }
  }

  private clearFlush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.output = '';
  }

  dispose(): void {
    this.view = undefined;
    this.clearFlush();
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.reruns.clear();
    this.active = undefined;
    this.selection.dispose();
    this.intent.dispose();
    this.breakpointIntent.dispose();
    this.settled.dispose();
    this.removed.dispose();
  }
}
