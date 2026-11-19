import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { BreakpointMute } from './breakpointMute';
import { quoteShell } from './paths';
import { DebugMessage, DebugMessageReader, encodeMessage } from './protocol';
import { openChannel, shutdownTimeout, startupTimeout } from './sshChannel';
import { SessionTerminal } from './terminal';
import { Outcome, exitOutcome } from './sessionState';

export interface PythonLaunch {
  python: string;
  cwd: string;
  program?: string;
  module?: string;
  args: string[];
  env: Record<string, string>;
}

export interface AdapterLaunch extends PythonLaunch {
  localRoot: string;
  remoteRoot: string;
  justMyCode: boolean;
  stopOnEntry: boolean;
}

export interface SessionAdapter extends vscode.DebugAdapter {
  readonly completion: Promise<Outcome>;
}

const adapterBootstrap =
  'import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); ' +
  'runpy.run_module("debugpy.adapter", run_name="__main__", alter_sys=True)';

export class RemoteAdapter implements SessionAdapter {
  private readonly emitter = new vscode.EventEmitter<DebugMessage>();
  private readonly reader = new DebugMessageReader();
  private readonly requests = new Map<
    number,
    { seq: number; command: string; reply?: (message: DebugMessage) => void }
  >();
  private wireSequence = 0;
  private readonly breakpoints = new BreakpointMute((request, muted) =>
    this.reapplyBreakpointRequest(request, muted)
  );
  private readonly exceptionFilters = new Set<string>();
  private closed = false;
  private disposed = false;
  private failure: string | undefined;
  private stderr = '';
  private started = false;
  private terminated = false;
  private stopping = false;
  private acknowledgedStop = false;
  private exitCode?: number;
  private sequence = 0;
  private complete!: (outcome: Outcome) => void;
  readonly completion = new Promise<Outcome>(resolve => (this.complete = resolve));
  private readonly handshake: NodeJS.Timeout;
  private closingTimer?: NodeJS.Timeout;
  private detach?: () => void;
  readonly onDidSendMessage = this.emitter.event;

  static async start(
    client: Client,
    plan: AdapterLaunch,
    helper: string,
    terminal: SessionTerminal,
    log: vscode.OutputChannel
  ): Promise<RemoteAdapter> {
    const command =
      'exec ' + [plan.python, '-I', '-u', '-c', adapterBootstrap, helper].map(quoteShell).join(' ');
    return new RemoteAdapter(await openChannel(client, command), plan, terminal, log);
  }

  private constructor(
    private readonly channel: ClientChannel,
    private readonly plan: AdapterLaunch,
    private readonly terminal: SessionTerminal,
    private readonly log: vscode.OutputChannel
  ) {
    this.handshake = setTimeout(() => {
      this.fail('The server did not complete the debugpy handshake.');
      this.forceClose();
    }, startupTimeout);

    const data = (chunk: Buffer) => {
      try {
        this.reader.push(chunk, message => this.receive(message));
      } catch (error) {
        this.fail(error.message);
        this.forceClose();
      }
    };
    const stderr = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderr = (this.stderr + text).slice(-2048);
      this.terminal.write(text);
      this.log.append(text);
    };
    const failure = (error: Error) => {
      this.fail(error.message);
      this.forceClose();
    };
    const close = () => this.finish();
    channel.on('data', data);
    channel.stderr.on('data', stderr);
    channel.on('error', failure);
    channel.once('close', close);
    this.detach = () => {
      channel.off('data', data);
      channel.stderr.off('data', stderr);
      channel.off('error', failure);
      channel.off('close', close);
      channel.on('error', ignoreLateChannelError);
    };
  }

  private receive(message: DebugMessage): void {
    this.sequence = Math.max(this.sequence, message.seq);
    if (message.type === 'response') {
      const request = this.requests.get(message.request_seq!);
      if (!request) {
        return;
      }
      this.requests.delete(message.request_seq!);
      if (request.reply) {
        request.reply(message);
        return;
      }
      message.request_seq = request.seq;
      if (message.command === 'initialize') {
        clearTimeout(this.handshake);
        const filters = message.body?.exceptionBreakpointFilters;
        if (Array.isArray(filters)) {
          for (const entry of filters) {
            if (typeof entry?.filter === 'string') this.exceptionFilters.add(entry.filter);
          }
        }
      }
      if (message.command === 'disconnect' && message.success) {
        this.acknowledgedStop = this.stopping;
        this.endChannel();
      }
      if (message.command === 'launch') {
        if (message.success) {
          this.started = true;
        } else {
          this.failure = message.message || 'debugpy could not launch Python.';
          this.endChannel();
        }
      }
    }
    if (message.event === 'process') {
      this.started = true;
      if (typeof message.body?.systemProcessId === 'number') {
        this.terminal.update(this.stopping ? 'Stopping' : 'Running', message.body.systemProcessId);
      }
    }
    if (message.event === 'terminated') {
      this.terminated = true;
      this.armCloseTimeout();
    }
    if (message.event === 'exited' && typeof message.body?.exitCode === 'number') {
      this.exitCode = message.body.exitCode;
      this.terminal.write('\n[RunHop] Process exited with code ' + this.exitCode + '.\n');
    }
    if (
      message.event === 'output' &&
      (message.body?.category === 'stdout' || message.body?.category === 'stderr') &&
      typeof message.body.output === 'string'
    ) {
      this.terminal.write(message.body.output);
    }
    this.emitter.fire(message);
  }

  private fail(message: string): void {
    if (this.failure) {
      return;
    }
    this.failure = message;
    this.log.appendLine('RunHop: ' + message);
    this.terminal.write('\n[RunHop] ' + message + '\n');
    if (this.requests.size) {
      for (const request of this.requests.values()) {
        if (request.reply) {
          request.reply({ seq: 0, type: 'response', success: false, message });
        } else {
          this.rejectRequest(request.seq, request.command, message);
        }
      }
      this.requests.clear();
    } else if (!this.disposed && !this.terminated) {
      void vscode.window.showErrorMessage('RunHop: ' + message);
    }
  }

  private rejectRequest(seq: number, command: string, message: string): void {
    this.emitter.fire({
      type: 'response',
      seq: ++this.sequence,
      request_seq: seq,
      command,
      success: false,
      message,
    });
  }

  handleMessage(raw: vscode.DebugProtocolMessage): void {
    const message = raw as DebugMessage;
    if (this.failure || this.closed) {
      if (message.type === 'request') {
        this.rejectRequest(
          message.seq,
          message.command!,
          this.failure || 'The SSH channel is closed.'
        );
      }
      return;
    }
    if (message.command === 'runhop.setBreakpointsMuted' && message.type === 'request') {
      void this.breakpoints.setMuted(message.arguments?.muted === true).then(
        () =>
          this.emitter.fire({
            seq: ++this.sequence,
            type: 'response',
            command: message.command,
            request_seq: message.seq,
            success: true,
          }),
        error => this.rejectRequest(message.seq, message.command!, error.message)
      );
      return;
    }
    if (message.command === 'runhop.setExceptionFilter' && message.type === 'request') {
      const { filter, enabled } = message.arguments ?? {};
      if (
        !this.started ||
        this.stopping ||
        this.terminated ||
        typeof filter !== 'string' ||
        !this.exceptionFilters.has(filter) ||
        typeof enabled !== 'boolean'
      ) {
        this.rejectRequest(
          message.seq,
          message.command,
          'Exception filter is unavailable in this session.'
        );
        return;
      }
      void this.breakpoints.setExceptionFilter(filter, enabled).then(
        request => {
          if (request) {
            this.emitter.fire({
              seq: ++this.sequence,
              type: 'event',
              event: 'runhop.exceptionFilters',
              body: { request },
            });
          }
          this.emitter.fire({
            seq: ++this.sequence,
            type: 'response',
            command: message.command,
            request_seq: message.seq,
            success: true,
          });
        },
        error => this.rejectRequest(message.seq, message.command!, error.message)
      );
      return;
    }
    if (message.command === 'launch') {
      const { localRoot, remoteRoot, python, ...launch } = this.plan;
      message.arguments = {
        ...launch,
        python: [python],
        console: 'internalConsole',
        redirectOutput: true,
        subProcess: false,
        pathMappings: [{ localRoot, remoteRoot }],
      };
    }
    if (message.command === 'disconnect') {
      message.arguments = { ...message.arguments, terminateDebuggee: true };
    }
    if (message.command === 'disconnect' || message.command === 'terminate') {
      this.stopping = this.stopping || !this.terminated;
      if (this.stopping) {
        this.terminal.update('Stopping');
      }
      this.armCloseTimeout();
    }
    this.send(this.breakpoints.track(message));
  }

  private send(message: DebugMessage, reply?: (message: DebugMessage) => void): number {
    if (message.type === 'request' && message.command) {
      const seq = ++this.wireSequence;
      this.requests.set(seq, { seq: message.seq, command: message.command, reply });
      message = { ...message, seq };
    }
    this.channel.write(encodeMessage(message));
    return message.seq;
  }

  private reapplyBreakpointRequest(request: DebugMessage, muted: boolean): Promise<void> {
    if (this.closed || this.failure || this.stopping) {
      return Promise.reject(new Error('The debug session is ending.'));
    }
    return new Promise((resolve, reject) => {
      const seq = this.send(request, response => {
        clearTimeout(timeout);
        if (!response.success) {
          reject(new Error(response.message || 'The adapter rejected the breakpoint request.'));
          return;
        }
        if (
          !muted &&
          this.breakpoints.isCurrent(request) &&
          (request.command === 'setBreakpoints' || request.command === 'setFunctionBreakpoints')
        ) {
          this.emitter.fire({
            seq: ++this.sequence,
            type: 'event',
            event: 'runhop.breakpointStatus',
            body: {
              request,
              resolved: response.body?.breakpoints,
            },
          });
        }
        resolve();
      });
      const timeout = setTimeout(() => {
        this.requests.delete(seq);
        reject(new Error('The adapter timed out updating breakpoints.'));
      }, shutdownTimeout);
    });
  }

  private armCloseTimeout(): void {
    if (!this.closed && !this.closingTimer) {
      this.closingTimer = setTimeout(() => this.forceClose(), shutdownTimeout);
    }
  }

  private endChannel(): void {
    if (!this.closed) {
      this.channel.end();
      this.armCloseTimeout();
    }
  }

  private forceClose(): void {
    this.channel.end();
    this.channel.close();
    this.finish();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detach?.();
    this.detach = undefined;
    clearTimeout(this.handshake);
    clearTimeout(this.closingTimer);
    let outcome: Outcome;
    if (this.exitCode !== undefined) {
      outcome = exitOutcome(this.exitCode, this.stopping);
    } else if (this.acknowledgedStop || (this.stopping && !this.started && !this.failure)) {
      outcome = { phase: 'Exited', detail: 'The debug session was stopped.' };
    } else {
      const detail =
        this.failure ||
        this.stderr.trim() ||
        'The SSH debugger closed without confirming Python exit.';
      outcome = { phase: this.started ? 'Disconnected' : 'Failed', detail };
      this.fail(detail);
    }
    if (!this.terminated) {
      this.terminated = true;
      this.emitter.fire({ type: 'event', event: 'terminated', seq: ++this.sequence });
    }
    for (const request of this.requests.values()) {
      request.reply?.({
        seq: 0,
        type: 'response',
        success: false,
        message: 'The debugger has ended.',
      });
    }
    this.requests.clear();
    this.breakpoints.clear();
    this.terminal.finish(outcome);
    this.complete(outcome);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.handshake);
    this.emitter.dispose();
    this.endChannel();
  }
}

function ignoreLateChannelError(): void {}
