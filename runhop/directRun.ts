import { randomBytes } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { PythonLaunch, SessionAdapter } from './adapter';
import { spawnPython, stopLocalProcess } from './localProcess';
import { quoteShell } from './paths';
import type { DebugMessage } from './protocol';
import { openChannel, shutdownTimeout } from './sshChannel';
import { SessionTerminal } from './terminal';
import { Outcome, exitOutcome } from './sessionState';

declare const RUNHOP_RUN_SUPERVISOR: string;

function commandFor(plan: PythonLaunch, token: string): string {
  const environment = Object.entries(plan.env).map(([name, value]) => name + '=' + value);
  const entry = plan.program ? [plan.program] : ['-m', plan.module!];
  const python = [plan.python, '-u', ...entry, ...plan.args];
  const invocation = [
    ...environment,
    plan.python,
    '-I',
    '-S',
    '-c',
    RUNHOP_RUN_SUPERVISOR,
    token,
    ...python,
  ];
  return 'cd ' + quoteShell(plan.cwd) + ' && exec env -- ' + invocation.map(quoteShell).join(' ');
}

export class DirectRun implements SessionAdapter {
  private readonly emitter = new vscode.EventEmitter<DebugMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private sequence = 0;
  private stopping = false;
  private started = false;
  private disposed = false;
  private done = false;
  private channel?: ClientChannel;
  private stopLocal?: () => void;
  private detach?: () => void;
  private closeTimer?: NodeJS.Timeout;
  private complete!: (outcome: Outcome) => void;
  readonly completion = new Promise<Outcome>(resolve => (this.complete = resolve));

  constructor(
    private readonly client: Client | undefined,
    private readonly plan: PythonLaunch,
    private readonly terminal: SessionTerminal,
    private readonly log: vscode.OutputChannel
  ) {}

  handleMessage(raw: vscode.DebugProtocolMessage): void {
    const request = raw as DebugMessage;
    switch (request.command) {
      case 'initialize':
        this.respond(request);
        this.event('initialized');
        break;
      case 'launch':
        if (this.started || this.stopping) {
          this.respond(request, 'This RunHop session has already started or stopped.');
        } else {
          void this.launch(request);
        }
        break;
      case 'threads':
        this.respond(request, undefined, { threads: [] });
        break;
      case 'disconnect':
      case 'terminate':
        this.stop();
        this.respond(request);
        break;
      default:
        this.respond(request, 'This request requires RunHop Debug.');
    }
  }

  private async launch(request: DebugMessage): Promise<void> {
    this.started = true;
    try {
      if (!this.client) {
        this.launchLocal(request);
        return;
      }
      const token = randomBytes(12).toString('hex');
      const channel = await openChannel(this.client, commandFor(this.plan, token));
      if (this.done) {
        channel.end();
        channel.close();
        return;
      }
      this.channel = channel;
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      let exitCode: number | undefined;
      let buffer = '';
      let pidSeen = false;
      const marker = new RegExp('\x1eRUNHOP_PID:' + token + ':(\\d+)\\r?\\n');
      const writeStderr = (text: string) => {
        if (pidSeen) {
          this.terminal.write(text);
          return;
        }
        buffer += text;
        const pid = marker.exec(buffer);
        if (pid) {
          this.terminal.update(this.stopping ? 'Stopping' : 'Running', Number(pid[1]));
          pidSeen = true;
          this.terminal.write(buffer.slice(0, pid.index) + buffer.slice(pid.index + pid[0].length));
          buffer = '';
        } else if (buffer.length > 100) {
          this.terminal.write(buffer.slice(0, -100));
          buffer = buffer.slice(-100);
        }
      };
      const data = (chunk: Buffer) => this.terminal.write(stdout.write(chunk));
      const errorData = (chunk: Buffer) => writeStderr(stderr.write(chunk));
      const exit = (code: number | null, signal?: string) => {
        exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : undefined);
      };
      const failure = (error: Error) => {
        this.terminal.write('\n[RunHop] ' + error.message + '\n');
        channel.close();
        this.finish({ phase: 'Disconnected', detail: error.message });
      };
      const close = () => {
        this.terminal.write(stdout.end());
        writeStderr(stderr.end());
        this.terminal.write(buffer);
        this.finish(
          exitCode === undefined
            ? {
                phase: 'Disconnected',
                detail: 'SSH closed without reporting a Python exit status.',
              }
            : exitOutcome(exitCode, this.stopping)
        );
      };
      channel.on('data', data);
      channel.stderr.on('data', errorData);
      channel.once('exit', exit);
      channel.on('error', failure);
      channel.once('close', close);
      this.detach = () => {
        channel.off('data', data);
        channel.stderr.off('data', errorData);
        channel.off('exit', exit);
        channel.off('error', failure);
        channel.off('close', close);
        channel.on('error', ignoreLateChannelError);
      };
      this.respond(request);
      if (this.stopping) {
        channel.end();
      }
    } catch (error) {
      this.respond(request, error.message);
      this.finish({ phase: 'Failed', detail: error.message });
    }
  }

  private launchLocal(request: DebugMessage): void {
    const entry = this.plan.program ? [this.plan.program] : ['-m', this.plan.module!];
    const child = spawnPython(this.plan, ['-u', ...entry, ...this.plan.args]);
    const execution = this.terminal.execution;
    const closeInput = () => {
      if (execution?.input) {
        execution.input = undefined;
        this.terminal.refresh();
      }
    };
    child.stdin.on('error', closeInput);
    child.stdin.once('close', closeInput);
    child.stdout.setEncoding('utf8').on('data', text => this.terminal.write(text));
    child.stderr.setEncoding('utf8').on('data', text => this.terminal.write(text));
    this.stopLocal = () => stopLocalProcess(child);
    child.once('spawn', () => {
      if (!this.stopping && execution && child.stdin.writable) {
        execution.input = line => {
          if (line === null) {
            closeInput();
            child.stdin.end();
          } else if (child.stdin.writableNeedDrain) {
            this.terminal.write('\n[RunHop] Program input is busy. Try sending it again.\n');
          } else if (child.stdin.writable) {
            child.stdin.write(line + '\n');
          }
        };
      }
      this.terminal.update(this.stopping ? 'Stopping' : 'Running', child.pid);
      this.respond(request);
    });
    child.on('error', error => {
      if (!child.pid) this.respond(request, error.message);
      this.finish({ phase: 'Failed', detail: error.message });
    });
    child.once('close', (code, signal) => {
      this.finish(
        code === null
          ? {
              phase: this.stopping ? 'Exited' : 'Failed',
              detail: 'Python ended with ' + signal + '.',
            }
          : exitOutcome(code, this.stopping)
      );
    });
  }

  private finish(outcome: Outcome): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.detach?.();
    this.detach = undefined;
    this.channel = undefined;
    this.stopLocal = undefined;
    clearTimeout(this.closeTimer);
    if (outcome.code !== undefined) {
      this.terminal.write('\n[RunHop] Process exited with code ' + outcome.code + '.\n');
      this.event('exited', { exitCode: outcome.code });
    } else if (outcome.detail) {
      this.terminal.write('\n[RunHop] ' + outcome.detail + '\n');
      this.log.appendLine('RunHop: ' + outcome.detail);
    }
    this.terminal.finish(outcome);
    this.complete(outcome);
    this.event('terminated');
  }

  private respond(request: DebugMessage, message?: string, body?: Record<string, unknown>): void {
    this.emitter.fire({
      seq: ++this.sequence,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: message === undefined,
      body,
      message,
    });
  }

  private event(event: string, body?: Record<string, unknown>): void {
    this.emitter.fire({ seq: ++this.sequence, type: 'event', event, body });
  }

  private stop(): void {
    if (this.stopping || this.done) {
      return;
    }
    this.stopping = true;
    this.terminal.update('Stopping');
    if (!this.started) {
      this.finish({ phase: 'Exited', detail: 'Run was cancelled before Python started.' });
      return;
    }
    if (this.stopLocal) {
      this.stopLocal();
      return;
    }
    this.channel?.end();
    this.closeTimer = setTimeout(() => {
      this.channel?.close();
      this.finish({
        phase: 'Disconnected',
        detail: 'Remote Python did not confirm exit before the stop timeout.',
      });
    }, shutdownTimeout);
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.stop();
      this.emitter.dispose();
    }
  }
}

function ignoreLateChannelError(): void {}
