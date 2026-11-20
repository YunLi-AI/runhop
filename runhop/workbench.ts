import * as path from 'path';
import * as vscode from 'vscode';
import { stripVTControlCharacters } from 'util';
import { BreakpointsManager } from './breakpoints';
import { BreakpointSession, BreakpointStatus } from './breakpointSession';
import { debugType, replay } from './launch';
import type { DebugMessage } from './protocol';
import { settingsFile } from './settings';
import type { SessionTerminal, TerminalPanel } from './terminal';
import { Outcome, SessionPhase, exitOutcome, formatPhase, rerunTokenKey } from './sessionState';

type Source = { path?: string; name?: string; sourceReference?: number };
type Frame = { id: number; name: string; source?: Source; line: number; column: number };
type Thread = {
  id: number;
  name: string;
  open?: boolean;
  total?: number;
  frames?: Frame[];
  error?: string;
  loading?: Promise<void>;
};
type Variable = {
  name: string;
  value?: string;
  type?: string;
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
};
type Node = Variable & {
  id: number;
  scope?: boolean;
  open?: boolean;
  children?: Node[];
  error?: string;
  loading?: boolean;
  limited?: boolean;
  more?: boolean;
  metadata?: string;
};
type Watch = { id: number; expression: string; auto: boolean };
type ConsoleLine = { text: string; kind: 'input' | 'result' | 'error' };
type ExceptionFilter = { filter: string; label: string; description?: string };

interface SessionState {
  session: vscode.DebugSession;
  phase: SessionPhase;
  outcome?: Outcome;
  exitCode?: number;
  started: boolean;
  stopRequested: boolean;
  launchFailure?: string;
  reason: string;
  epoch: number;
  frameEpoch: number;
  inspectEpoch: number;
  busy: boolean;
  threads: Thread[];
  stopped: Set<number>;
  terminated?: boolean;
  allStopped: boolean;
  thread?: number;
  frame?: Frame;
  nodes: Map<number, Node>;
  variablePages: Map<number, Variable[]>;
  scopes: Node[];
  scopesLoading: boolean;
  console: ConsoleLine[];
  history: string[];
  watchValues: Map<number, string>;
  breakpoints: BreakpointSession;
  breakpointCapabilities?: {
    functions: boolean;
    condition: boolean;
    hitCondition: boolean;
    logMessage: boolean;
  };
  exceptionFilters: ExceptionFilter[];
  muted: boolean;
  mutePending: boolean;
  smartStep: boolean;
  error?: string;
  terminal?: SessionTerminal;
}

type Intent = {
  action: string;
  session?: string;
  thread?: number;
  frame?: number;
  node?: number;
  id?: number | string;
  input?: string;
};
const variableLimit = 80;
const frameLimit = 40;
const nodeLimit = 1200;
const stringLimit = 6000;
const paused = (s: SessionState) => s.phase === 'Paused' || s.phase === 'Exception';
const truncate = (text: unknown) => {
  const value = String(text ?? '');
  return value.length > stringLimit ? value.slice(0, stringLimit) + '…' : value;
};
const errorText = (error: unknown) => truncate(error instanceof Error ? error.message : error);

function isPythonDebug(session: vscode.DebugSession): boolean {
  return (
    session.configuration.noDebug !== true &&
    (session.type === debugType || session.type === 'debugpy' || session.type === 'python')
  );
}

class DebugWorkbench {
  private readonly sessions = new Map<string, SessionState>();
  private selected?: string;
  private readonly breakpoints: BreakpointsManager;
  private nodeId = 0;
  private watchId = 0;
  private shortcutState: Record<string, boolean> = {};
  private watches: Watch[];
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
  });
  private highlighted?: vscode.TextEditor;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: TerminalPanel
  ) {
    this.breakpoints = new BreakpointsManager(context, panel, () => {
      const s = this.sessions.get(this.selected ?? '');
      if (!s || s.outcome || s.phase === 'Stopping') return undefined;
      const canSetException =
        s.started &&
        s.session.type === debugType &&
        !s.muted &&
        !s.mutePending &&
        s.breakpoints.exceptions !== undefined;
      return {
        id: s.session.id,
        name: s.session.name,
        muted: s.muted,
        ...s.breakpointCapabilities,
        status: bp => {
          if (!s.started) return undefined;
          if (bp instanceof vscode.FunctionBreakpoint) {
            return s.breakpoints.function(bp.functionName, bp);
          }
          const { uri, range } = bp.location;
          return s.breakpoints.source(
            uri.fsPath,
            range.start.line + 1,
            range.start.character + 1,
            bp
          );
        },
        exceptions: s.exceptionFilters.map(filter => ({
          ...filter,
          enabled: s.breakpoints.exceptions?.has(filter.filter),
        })),
        exceptionOverride: s.breakpoints.exceptionOverride,
        setException: canSetException
          ? async (filter, enabled) => {
              await s.session.customRequest('runhop.setExceptionFilter', { filter, enabled });
            }
          : undefined,
      };
    });
    this.watches = context.workspaceState.get<Watch[]>('runhop.watches', []);
    this.watchId = Math.max(0, ...this.watches.map(watch => watch.id));
    context.subscriptions.push(
      this.highlight,
      panel.onDidSelectDebugSession(id => {
        this.selected = id;
        this.clearHighlight();
        this.publish();
        const s = this.sessions.get(id ?? '');
        if (s?.frame && paused(s)) {
          void this.reveal(s, s.frame, s.frameEpoch).catch(error => this.report(s, error));
        }
      }),
      panel.onDidFinishDebugSession(({ id, outcome }) => {
        const s = this.sessions.get(id);
        if (s) {
          this.finishState(s, outcome);
        }
      }),
      panel.onDidRemoveDebugSession(id => {
        this.sessions.delete(id);
        this.publish();
      }),
      panel.onDebuggerIntent(value => {
        if (value && typeof value === 'object' && typeof (value as Intent).action === 'string') {
          void this.intent(value as Intent);
        }
      }),
      ...['stepIn', 'next', 'stepOut', 'continue', 'stop'].map(action =>
        vscode.commands.registerCommand('runhop.debug.' + action, async () => {
          const s = this.sessions.get(this.selected ?? '');
          if (s) {
            await this.intent({ session: s.session.id, action });
          }
        })
      ),
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: session => {
          if (!isPythonDebug(session)) {
            return undefined;
          }
          const s = this.ensure(session);
          return {
            onDidSendMessage: message => this.adapterMessage(s, message as DebugMessage),
            onWillReceiveMessage: (message: DebugMessage) => {
              if (
                message.type === 'request' &&
                !s.outcome &&
                s.phase !== 'Stopping' &&
                s.breakpoints.request(message)
              ) {
                this.breakpoints.publish();
              }
              if (
                message.type === 'request' &&
                (message.command === 'terminate' || message.command === 'disconnect') &&
                s.phase !== 'Stopping' &&
                !s.outcome
              ) {
                s.stopRequested = true;
                this.ending(s);
              }
            },
            onError: error => this.report(s, error),
            onExit: () => this.finishNative(s),
          };
        },
      }),
      vscode.debug.onDidStartDebugSession(session => {
        if (isPythonDebug(session)) {
          this.ensure(session);
        }
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const s = this.sessions.get(session.id);
        if (s) {
          this.finishNative(s);
        }
      }),
      vscode.debug.onDidChangeActiveStackItem(item => {
        if (!(item instanceof vscode.DebugStackFrame)) {
          return;
        }
        const s = this.sessions.get(item.session.id);
        if (s && paused(s) && this.threadPaused(s, item.threadId) && s.frame?.id !== item.frameId) {
          const thread = s.threads.find(thread => thread.id === item.threadId);
          if (thread) {
            void this.inspect(s, thread, item.frameId).catch(error => this.report(s, error));
          }
        }
      })
    );
  }

  private ensure(session: vscode.DebugSession): SessionState {
    const existing = this.sessions.get(session.id);
    if (existing) {
      return existing;
    }
    const s: SessionState = {
      session,
      phase: 'Starting',
      started: false,
      stopRequested: false,
      reason: '',
      epoch: 0,
      frameEpoch: 0,
      inspectEpoch: 0,
      busy: false,
      threads: [],
      stopped: new Set(),
      allStopped: false,
      nodes: new Map(),
      variablePages: new Map(),
      scopes: [],
      scopesLoading: false,
      console: [],
      history: [],
      watchValues: new Map(),
      breakpoints: new BreakpointSession(),
      exceptionFilters: [],
      muted: false,
      mutePending: false,
      smartStep: false,
    };
    this.sessions.set(session.id, s);
    if (session.type !== debugType) {
      s.terminal = this.panel.create(
        'Debug · ' + session.name,
        false,
        session.id,
        {
          id: session.id,
          workspace: session.workspaceFolder?.uri.toString(),
          program: session.configuration.program,
          configurationFile: session.configuration.runhopUsesProjectSettings
            ? settingsFile
            : '.vscode/launch.json',
          stop: async () => {
            await vscode.debug.stopDebugging(session);
          },
          rerun:
            session.configuration.request === 'launch'
              ? replay(session.workspaceFolder, session.configuration)
              : undefined,
        },
        session.configuration[rerunTokenKey]
      );
      s.terminal.write('[RunHop] Capturing output delivered by the Python debug adapter.\n');
    }
    this.breakpoints.publish();
    this.publish();
    return s;
  }

  private adapterMessage(s: SessionState, message: DebugMessage): void {
    if (s.outcome) {
      return;
    }
    const body = message.body;
    if (message.type === 'response' && s.phase !== 'Stopping' && s.breakpoints.response(message)) {
      this.breakpoints.publish();
    }
    if (
      message.type === 'response' &&
      !message.success &&
      (message.command === 'launch' || message.command === 'attach')
    ) {
      s.launchFailure = message.message || 'The debugger could not start Python.';
    }
    if (message.type === 'response' && message.success) {
      if (message.command === 'initialize') {
        s.smartStep = body?.supportsStepInTargetsRequest === true;
        s.breakpointCapabilities = {
          functions: body?.supportsFunctionBreakpoints === true,
          condition: body?.supportsConditionalBreakpoints === true,
          hitCondition: body?.supportsHitConditionalBreakpoints === true,
          logMessage: body?.supportsLogPoints === true,
        };
        s.exceptionFilters =
          (body?.exceptionBreakpointFilters as ExceptionFilter[] | undefined) ?? [];
        this.breakpoints.publish();
      }
      if (
        (message.command === 'launch' || message.command === 'attach') &&
        s.phase === 'Starting'
      ) {
        s.phase = 'Running';
        s.started = true;
        this.publish();
        void this.runningThreads(s);
      }
    }
    if (message.type !== 'event') {
      return;
    }
    switch (message.event) {
      case 'process':
        s.started = true;
        if (typeof body?.systemProcessId === 'number') {
          this.panel.updateDebugSession(s.session.id, s.phase, body.systemProcessId);
        }
        if (s.phase === 'Starting') {
          s.phase = 'Running';
          this.publish();
          void this.runningThreads(s);
        }
        break;
      case 'stopped':
        if (s.phase === 'Stopping') {
          break;
        }
        s.started = true;
        this.invalidate(s);
        s.allStopped ||= body?.allThreadsStopped === true;
        if (Number.isInteger(body?.threadId)) {
          s.thread = body!.threadId as number;
          s.stopped.add(s.thread);
        } else {
          s.allStopped = true;
          s.thread = undefined;
        }
        s.phase = body?.reason === 'exception' ? 'Exception' : 'Paused';
        s.reason = truncate(body?.description || body?.text || body?.reason);
        s.error = undefined;
        this.publish();
        void this.refreshStack(s).catch(error => this.report(s, error));
        break;
      case 'continued':
        this.continued(s, body?.threadId as number, body?.allThreadsContinued !== false);
        break;
      case 'thread':
        if (body?.reason === 'exited' && typeof body.threadId === 'number') {
          s.stopped.delete(body.threadId);
          s.threads = s.threads.filter(thread => thread.id !== body.threadId);
          this.publish();
        } else if (body?.reason === 'started' && s.phase === 'Running') {
          void this.runningThreads(s);
        }
        break;
      case 'invalidated':
        if (paused(s)) {
          this.invalidate(s);
          void this.refreshStack(s).catch(error => this.report(s, error));
        }
        break;
      case 'breakpoint':
        if (s.breakpoints.event(body?.reason, body?.breakpoint as BreakpointStatus | undefined)) {
          this.breakpoints.publish();
        }
        break;
      case 'runhop.breakpointStatus':
      case 'runhop.exceptionFilters':
        if (
          body?.request &&
          s.breakpoints.accept(
            body.request as DebugMessage,
            body?.resolved,
            message.event === 'runhop.exceptionFilters'
          )
        ) {
          this.breakpoints.publish();
        }
        break;
      case 'output':
        if (body?.category !== 'telemetry' && typeof body?.output === 'string') {
          if (s.terminal || (body.category !== 'stdout' && body.category !== 'stderr')) {
            if (s.terminal) {
              s.terminal.write(body.output);
            } else if (body.category === 'console' || body.category === 'important') {
              this.panel.writeDebugOutput(s.session.id, body.output);
            }
          }
        }
        break;
      case 'terminated':
        s.terminated = true;
        this.ending(s);
        break;
      case 'exited':
        if (typeof body?.exitCode === 'number') {
          s.exitCode = body.exitCode;
        }
        this.ending(s);
        break;
    }
  }

  private ending(s: SessionState): void {
    if (!s.outcome && s.phase !== 'Stopping') {
      this.invalidate(s);
      s.phase = 'Stopping';
      s.breakpoints.clear();
      s.reason = '';
      s.threads = [];
      s.thread = undefined;
      s.stopped.clear();
      s.allStopped = false;
      this.publish();
    }
  }

  private finishNative(s: SessionState): void {
    if (!s.terminal || s.outcome) {
      return;
    }
    const outcome: Outcome =
      s.exitCode !== undefined
        ? exitOutcome(s.exitCode, s.stopRequested)
        : s.terminated && s.stopRequested
          ? { phase: 'Exited' }
          : s.launchFailure || !s.started
            ? {
                phase: 'Failed',
                detail: s.launchFailure || 'The debug adapter ended before Python started.',
              }
            : {
                phase: 'Disconnected',
                detail: 'The debug adapter ended without a Python exit status.',
              };
    s.terminal.finish(outcome);
  }

  private finishState(s: SessionState, outcome: Outcome): void {
    if (s.outcome) {
      return;
    }
    this.invalidate(s);
    s.outcome = outcome;
    s.phase = outcome.phase;
    s.reason = outcome.detail || '';
    s.busy = false;
    s.threads = [];
    s.thread = undefined;
    s.stopped.clear();
    s.allStopped = false;
    s.breakpoints.clear();
    s.exceptionFilters = [];
    s.muted = false;
    this.publish();
  }

  private invalidate(s: SessionState): void {
    s.epoch++;
    for (const thread of s.threads) {
      thread.frames = undefined;
      thread.open = false;
      thread.error = undefined;
      thread.loading = undefined;
    }
    this.clearFrame(s);
  }

  private clearFrame(s: SessionState): void {
    s.frameEpoch++;
    s.frame = undefined;
    s.scopes = [];
    s.scopesLoading = false;
    s.nodes.clear();
    s.variablePages.clear();
    s.watchValues.clear();
    if (this.selected === s.session.id) {
      this.clearHighlight();
    }
  }

  private continued(s: SessionState, threadId: number | undefined, all: boolean): void {
    if (s.outcome || s.phase === 'Stopping') {
      return;
    }
    if (all) {
      s.stopped.clear();
    } else if (s.allStopped) {
      s.stopped = new Set(
        s.threads.filter(thread => thread.id !== threadId).map(thread => thread.id)
      );
    } else if (threadId !== undefined) {
      s.stopped.delete(threadId);
    }
    s.allStopped = false;
    this.invalidate(s);
    s.phase = s.stopped.size ? 'Paused' : 'Running';
    s.reason = '';
    this.publish();
    if (paused(s)) {
      void this.refreshStack(s).catch(error => this.report(s, error));
    }
  }

  private threadPaused(s: SessionState, id: number): boolean {
    return s.allStopped || s.stopped.has(id);
  }

  private async runningThreads(s: SessionState): Promise<void> {
    const epoch = s.epoch;
    try {
      const result = await s.session.customRequest('threads');
      if (s.phase === 'Running' && epoch === s.epoch) {
        s.threads = (result.threads ?? []).map((thread: Thread) => ({
          id: thread.id,
          name: thread.name,
        }));
        this.publish();
      }
    } catch {
      // Some adapters only provide threads during a pause.
    }
  }

  private async refreshStack(s: SessionState): Promise<void> {
    const epoch = s.epoch;
    const result = await s.session.customRequest('threads');
    if (epoch !== s.epoch || !paused(s)) {
      return;
    }
    s.threads = (result.threads || []).map((thread: Thread) => ({
      id: thread.id,
      name: thread.name,
    }));
    const current =
      s.threads.find(thread => thread.id === s.thread && this.threadPaused(s, thread.id)) ||
      s.threads.find(thread => this.threadPaused(s, thread.id));
    if (current) {
      const focused = vscode.debug.activeStackItem;
      await this.inspect(
        s,
        current,
        focused instanceof vscode.DebugStackFrame &&
          focused.session.id === s.session.id &&
          focused.threadId === current.id
          ? focused.frameId
          : undefined
      );
    } else {
      this.publish();
    }
  }

  private async stack(s: SessionState, thread: Thread, more = false): Promise<void> {
    if (thread.loading) {
      return thread.loading;
    }
    if (!paused(s) || !this.threadPaused(s, thread.id) || (thread.frames && !more)) {
      return;
    }
    const load = this.loadFrames(s, thread);
    thread.loading = load;
    try {
      await load;
    } finally {
      if (thread.loading === load) {
        thread.loading = undefined;
      }
    }
  }

  private async loadFrames(s: SessionState, thread: Thread): Promise<void> {
    const epoch = s.epoch;
    const initial = thread.frames ?? [];
    try {
      const result = await s.session.customRequest('stackTrace', {
        threadId: thread.id,
        startFrame: initial.length,
        levels: frameLimit,
      });
      if (epoch === s.epoch) {
        thread.frames = initial
          .concat((result.stackFrames ?? []).slice(0, frameLimit))
          .slice(0, 200);
        thread.total = result.totalFrames;
        thread.error = undefined;
      }
    } catch (error) {
      if (epoch === s.epoch) {
        thread.error = errorText(error);
      }
    }
    this.publish();
  }

  private async inspect(
    s: SessionState,
    thread: Thread,
    frameId?: number,
    reveal = false
  ): Promise<void> {
    const epoch = s.epoch;
    const request = ++s.inspectEpoch;
    thread.open = true;
    await this.stack(s, thread);
    if (epoch !== s.epoch || request !== s.inspectEpoch || !paused(s)) {
      return;
    }
    const frame =
      frameId === undefined
        ? thread.frames?.[0]
        : thread.frames?.find(frame => frame.id === frameId);
    if (!frame || (s.thread === thread.id && s.frame?.id === frame.id && !reveal)) {
      this.publish();
      return;
    }
    this.clearFrame(s);
    s.thread = thread.id;
    s.frame = frame;
    const frameEpoch = s.frameEpoch;
    this.publish();
    if (reveal) {
      void this.reveal(s, frame, frameEpoch).catch(error => this.report(s, error));
    }
    const scopes = this.scopes(s, frame, frameEpoch);
    for (const watch of this.watches.filter(watch => watch.auto)) {
      if (frameEpoch !== s.frameEpoch) {
        break;
      }
      await this.evaluateWatch(s, watch);
    }
    await scopes;
  }

  private async reveal(s: SessionState, frame: Frame, epoch: number): Promise<void> {
    if (!frame.source?.path && !frame.source?.sourceReference) {
      return;
    }
    const uri = vscode.debug.asDebugSourceUri(frame.source, s.session);
    const document = await vscode.workspace.openTextDocument(uri);
    if (epoch !== s.frameEpoch || this.selected !== s.session.id) {
      return;
    }
    const position = document.validatePosition(
      new vscode.Position(Math.max(0, frame.line - 1), Math.max(0, frame.column - 1))
    );
    const range = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      selection: range,
      preserveFocus: true,
      viewColumn: this.breakpoints.sourceColumn(uri),
    });
    if (epoch === s.frameEpoch && this.selected === s.session.id) {
      this.clearHighlight();
      this.highlighted = editor;
      editor.setDecorations(this.highlight, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private clearHighlight(): void {
    this.highlighted?.setDecorations(this.highlight, []);
    this.highlighted = undefined;
  }

  private node(s: SessionState, variable: Variable, scope = false): Node {
    const node: Node = {
      id: ++this.nodeId,
      scope,
      name: truncate(variable.name),
      value: truncate(variable.value),
      type: truncate(variable.type),
      evaluateName: variable.evaluateName,
      variablesReference: variable.variablesReference,
      indexedVariables: variable.indexedVariables,
      namedVariables: variable.namedVariables,
    };
    s.nodes.set(node.id, node);
    return node;
  }

  private async scopes(s: SessionState, frame: Frame, epoch: number): Promise<void> {
    s.scopesLoading = true;
    this.publish();
    try {
      const { scopes } = await s.session.customRequest('scopes', { frameId: frame.id });
      if (epoch !== s.frameEpoch || !paused(s)) {
        return;
      }
      s.scopes = (scopes ?? []).slice(0, 20).map(scope => this.node(s, scope, true));
      const main =
        s.scopes.find(node => /local/i.test(node.name)) ||
        s.scopes.find(node => !scopes.find(scope => scope.name === node.name)?.expensive);
      this.publish();
      if (main) {
        await this.expand(s, main);
      }
    } catch (error) {
      if (epoch === s.frameEpoch) {
        this.report(s, error);
      }
    } finally {
      if (epoch === s.frameEpoch) {
        s.scopesLoading = false;
        this.publish();
      }
    }
  }

  private async expand(s: SessionState, node: Node): Promise<void> {
    if (!paused(s) || !node.variablesReference) {
      return;
    }
    node.open = !node.open;
    this.publish();
    if (!node.open || node.children || node.loading) {
      return;
    }
    if (s.nodes.size >= nodeLimit) {
      node.error = 'Variable limit reached for this frame.';
      this.publish();
      return;
    }
    const epoch = s.frameEpoch;
    node.loading = true;
    node.error = undefined;
    this.publish();
    try {
      const { variables } = await s.session.customRequest('variables', {
        variablesReference: node.variablesReference,
      });
      if (epoch === s.frameEpoch) {
        const pending = [...s.variablePages.values()].reduce((sum, items) => sum + items.length, 0);
        const limit = Math.max(0, nodeLimit - s.nodes.size - pending);
        const page = (variables ?? []).slice(0, limit);
        node.children = [];
        if (page.length) s.variablePages.set(node.id, page);
        node.limited =
          (variables?.length ?? 0) > limit ||
          (node.indexedVariables ?? 0) + (node.namedVariables ?? 0) > limit;
        this.moreVariables(s, node);
      }
    } catch (error) {
      if (epoch === s.frameEpoch) {
        node.error = errorText(error);
      }
    } finally {
      if (epoch === s.frameEpoch) {
        node.loading = false;
        this.publish();
      }
    }
  }

  private moreVariables(s: SessionState, node: Node): void {
    const items = s.variablePages.get(node.id);
    if (!paused(s) || !items) return;
    const children = node.children ?? (node.children = []);
    const size = Math.min(variableLimit, nodeLimit - s.nodes.size);
    children.push(...items.splice(0, size).map(variable => this.node(s, variable)));
    node.more = items.length > 0 && s.nodes.size < nodeLimit;
    if (!node.more) {
      node.limited ||= items.length > 0;
      s.variablePages.delete(node.id);
    }
    if (/(?:ndarray|Tensor|Parameter)/i.test(node.type ?? '')) {
      node.metadata = children
        .filter(child => /^(?:shape|dtype|device)$/.test(child.name) && child.value)
        .map(child => child.name + ' ' + child.value)
        .join(' · ');
    }
    this.publish();
  }

  private async execution(s: SessionState, action: string, targetId?: number): Promise<void> {
    if (
      s.busy ||
      s.outcome ||
      s.phase === 'Stopping' ||
      (s.phase === 'Starting' && action !== 'stop')
    ) {
      return;
    }
    const epoch = s.epoch;
    s.busy = true;
    s.error = undefined;
    this.publish();
    try {
      if (action === 'stop') {
        await vscode.debug.stopDebugging(s.session);
      } else if (action === 'pause' && s.phase === 'Running') {
        const result = await s.session.customRequest('threads');
        const thread =
          result.threads?.find(thread => thread.id === s.thread) ?? result.threads?.[0];
        if (!thread) {
          throw new Error('The adapter did not report a thread to pause.');
        }
        if (epoch === s.epoch && s.phase === 'Running') {
          await s.session.customRequest('pause', { threadId: thread.id });
        }
      } else if (
        paused(s) &&
        s.thread !== undefined &&
        this.threadPaused(s, s.thread) &&
        ['continue', 'next', 'stepIn', 'stepOut'].includes(action)
      ) {
        const result = await s.session.customRequest(action, {
          threadId: s.thread,
          ...(targetId !== undefined ? { targetId } : {}),
        });
        if (epoch === s.epoch) {
          this.continued(s, s.thread, result?.allThreadsContinued !== false);
        }
      }
    } finally {
      s.busy = false;
      this.publish();
    }
  }

  private async toggleMute(s: SessionState): Promise<void> {
    if (
      s.session.type !== debugType ||
      !s.started ||
      s.outcome ||
      s.phase === 'Stopping' ||
      s.mutePending
    ) {
      return;
    }
    s.mutePending = true;
    this.publish();
    try {
      const muted = !s.muted;
      await s.session.customRequest('runhop.setBreakpointsMuted', { muted });
      if (!s.outcome) {
        s.muted = muted;
      }
    } finally {
      s.mutePending = false;
      this.publish();
    }
  }

  private async showExecutionPoint(s: SessionState): Promise<void> {
    if (!paused(s) || s.thread === undefined) {
      return;
    }
    const thread = s.threads.find(item => item.id === s.thread);
    if (thread && this.threadPaused(s, thread.id)) {
      await this.loadFrames(s, thread);
      const top = thread.frames?.[0];
      if (top) {
        await this.inspect(s, thread, top.id, true);
      }
    }
  }

  private async smartStepInto(s: SessionState): Promise<void> {
    if (!s.smartStep || !paused(s) || !s.frame || s.thread === undefined || s.busy) {
      return;
    }
    const { frame, frameEpoch } = s;
    const result = await s.session.customRequest('stepInTargets', { frameId: frame.id });
    if (this.selected !== s.session.id || frameEpoch !== s.frameEpoch) {
      return;
    }
    const targets: { label: string; id: number }[] = result.targets ?? [];
    if (!targets.length) {
      throw new Error('The adapter did not report any functions to step into at this line.');
    }
    const target = await vscode.window.showQuickPick(targets, {
      title: 'RunHop · Smart Step Into',
    });
    if (target && this.selected === s.session.id && frameEpoch === s.frameEpoch) {
      await this.execution(s, 'stepIn', target.id);
    }
  }

  private async evaluate(s: SessionState, expression: string): Promise<void> {
    if (!paused(s) || !s.frame || !expression.trim() || expression.length > stringLimit) {
      return;
    }
    const frame = s.frame;
    const epoch = s.frameEpoch;
    s.history = [...s.history.slice(-49), expression];
    this.consoleLine(s, 'input', expression);
    try {
      const result = await s.session.customRequest('evaluate', {
        expression,
        frameId: frame.id,
        context: 'repl',
      });
      this.consoleLine(s, 'result', truncate(result?.result));
    } catch (error) {
      this.consoleLine(s, 'error', errorText(error));
    }
    if (epoch === s.frameEpoch && paused(s)) {
      s.frameEpoch++;
      s.scopes = [];
      s.nodes.clear();
      s.variablePages.clear();
      s.watchValues.clear();
      await this.scopes(s, frame, s.frameEpoch);
    }
  }

  private consoleLine(s: SessionState, kind: ConsoleLine['kind'], text: string): void {
    s.console = [...s.console.slice(-119), { kind, text }];
    this.publish();
  }

  private async watchAction(s: SessionState, action: string, id?: number): Promise<void> {
    const existing = this.watches.find(watch => watch.id === id);
    if (action === 'evaluateWatch' && existing) {
      await this.evaluateWatch(s, existing);
      return;
    }
    if (action === 'removeWatch' && existing) {
      this.watches = this.watches.filter(watch => watch !== existing);
    } else if (action === 'addWatch' || (action === 'editWatch' && existing)) {
      const expression = await vscode.window.showInputBox({
        title: 'RunHop · Watch Expression',
        value: existing?.expression,
        validateInput: value =>
          !value.trim() || value.length > stringLimit ? 'Enter a Python expression.' : undefined,
      });
      if (!expression) {
        return;
      }
      let auto = /^[A-Za-z_][A-Za-z_0-9]*$/.test(expression.trim());
      if (!auto) {
        const mode = await vscode.window.showQuickPick(
          ['Evaluate Manually', 'Evaluate Automatically'],
          {
            title: 'A watch expression may change program state',
            placeHolder: 'Choose when to run this expression in the paused Python process',
          }
        );
        if (!mode) {
          return;
        }
        auto = mode === 'Evaluate Automatically';
      }
      this.watches = this.watches.filter(watch => watch !== existing);
      this.watches.push({ id: ++this.watchId, expression, auto });
    }
    await this.context.workspaceState.update('runhop.watches', this.watches);
    this.publish();
    const latest = this.watches.at(-1);
    if (action !== 'removeWatch' && latest?.auto) {
      await this.evaluateWatch(s, latest);
    }
  }

  private async evaluateWatch(s: SessionState, watch: Watch): Promise<void> {
    if (!paused(s) || !s.frame) {
      return;
    }
    const epoch = s.frameEpoch;
    let value: string;
    try {
      const result = await s.session.customRequest('evaluate', {
        expression: watch.expression,
        frameId: s.frame.id,
        context: 'watch',
      });
      value = truncate(result?.result);
    } catch (error) {
      value = 'Error: ' + errorText(error);
    }
    if (epoch === s.frameEpoch) {
      s.watchValues.set(watch.id, value);
      this.publish();
    }
  }

  private async intent(intent: Intent): Promise<void> {
    const s = this.sessions.get(this.selected ?? '');
    if (!s || intent.session !== s.session.id) {
      return;
    }
    try {
      const thread = s.threads.find(thread => thread.id === intent.thread);
      const node = intent.node === undefined ? undefined : s.nodes.get(intent.node);
      switch (intent.action) {
        case 'showExecutionPoint':
          await this.showExecutionPoint(s);
          break;
        case 'muteBreakpoints':
          await this.toggleMute(s);
          break;
        case 'smartStepInto':
          await this.smartStepInto(s);
          break;
        case 'copyConsole':
          await vscode.env.clipboard.writeText(
            s.console.map(line => (line.kind === 'input' ? '>>> ' : '') + line.text).join('\n')
          );
          break;
        case 'thread':
          if (thread) {
            if (thread.open) {
              thread.open = false;
              this.publish();
            } else {
              await this.inspect(s, thread);
            }
          }
          break;
        case 'framesMore':
          if (thread && (thread.frames?.length ?? 0) < 200) {
            await this.stack(s, thread, true);
          }
          break;
        case 'frame':
          if (thread && Number.isInteger(intent.frame)) {
            await this.inspect(s, thread, intent.frame, true);
          }
          break;
        case 'variable':
          if (node) {
            await this.expand(s, node);
          }
          break;
        case 'variablesMore':
          if (node?.open) this.moreVariables(s, node);
          break;
        case 'preview':
          if (node?.evaluateName && s.frame && paused(s) && s.session.type === debugType) {
            await vscode.commands.executeCommand('runhop.preview', {
              sessionId: s.session.id,
              session: s.session,
              frameId: s.frame.id,
              variable: node,
            });
          }
          break;
        case 'evaluate':
          if (typeof intent.input === 'string') {
            await this.evaluate(s, intent.input);
          }
          break;
        case 'clearConsole':
          s.console = [];
          this.publish();
          break;
        case 'clearOutput':
          this.panel.clearDebugOutput(s.session.id);
          break;
        case 'copyOutput':
          await vscode.env.clipboard.writeText(
            stripVTControlCharacters(this.panel.debugOutput(s.session.id))
          );
          break;
        case 'addWatch':
        case 'removeWatch':
        case 'editWatch':
        case 'evaluateWatch':
          await this.watchAction(
            s,
            intent.action,
            typeof intent.id === 'number' ? intent.id : undefined
          );
          break;
        case 'continue':
        case 'pause':
        case 'next':
        case 'stepIn':
        case 'stepOut':
        case 'stop':
          await this.execution(s, intent.action);
          break;
      }
    } catch (error) {
      this.report(s, error);
    }
  }

  private report(s: SessionState, error: unknown): void {
    s.error = errorText(error);
    this.publish();
  }

  private publish(): void {
    this.breakpoints.publish();
    for (const entry of this.sessions.values()) {
      if (!entry.outcome) {
        this.panel.updateDebugSession(entry.session.id, entry.phase);
      }
    }
    const s = this.sessions.get(this.selected ?? '');
    const canStep = Boolean(
      s && paused(s) && s.thread !== undefined && this.threadPaused(s, s.thread)
    );
    const keys = {
      'runhop.debugCanStep': canStep && !s?.busy,
      'runhop.debugCanStop': Boolean(s && !s.busy && !s.outcome && s.phase !== 'Stopping'),
    };
    for (const [key, enabled] of Object.entries(keys)) {
      if (this.shortcutState[key] !== enabled) {
        this.shortcutState[key] = enabled;
        void vscode.commands.executeCommand('setContext', key, enabled);
      }
    }
    if (!s) {
      this.panel.showDebugger(null);
      return;
    }
    this.panel.showDebugger({
      id: s.session.id,
      title: s.session.name,
      phase: s.phase,
      phaseLabel: formatPhase(s.phase, s.outcome?.code),
      ended: Boolean(s.outcome),
      reason: s.reason,
      busy: s.busy,
      error: s.error,
      canMute: s.session.type === debugType && s.started && !s.outcome && s.phase !== 'Stopping',
      muted: s.muted,
      mutePending: s.mutePending,
      canShowPoint: canStep && Boolean(s.frame),
      canSmartStep: canStep && s.smartStep,
      threads: s.threads.map(thread => ({
        id: thread.id,
        name: thread.name,
        open: thread.open,
        total: thread.total,
        error: thread.error,
        paused: paused(s) && this.threadPaused(s, thread.id),
        frames: thread.frames?.map(frame => ({
          id: frame.id,
          name: frame.name,
          location:
            (frame.source?.name || path.basename(frame.source?.path ?? '')) +
            (frame.line > 0 ? ':' + frame.line : ''),
        })),
      })),
      thread: s.thread,
      frame: s.frame?.id,
      canStep,
      variables: s.scopes,
      scopesLoading: s.scopesLoading,
      console: s.console,
      history: s.history,
      watches: this.watches.map(watch => ({ ...watch, value: s.watchValues.get(watch.id) })),
      preview: s.session.type === debugType,
    });
  }
}

export function registerWorkbench(context: vscode.ExtensionContext, panel: TerminalPanel): void {
  new DebugWorkbench(context, panel);
}
