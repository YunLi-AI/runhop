import { createInterface, type Interface } from 'node:readline';
import type { Client, ClientChannel } from 'ssh2';
import { quoteShell } from '../paths';
import { isRecord } from '../settings';
import { openChannel } from '../sshChannel';
import { execCommand } from '../transport/core/remote-client/exec';

const requestTimeout = 15_000;
const idleTimeout = 60_000;
const framePrefix = 'runhop-source ';

function command(python: string, helper: string, operation: string): string {
  return 'exec ' + [python, '-I', '-B', '-c', helper, operation].map(quoteShell).join(' ');
}

export async function inspectOnce(
  client: Client,
  python: string,
  helper: string,
  operation: 'locate' | 'replace',
  query: Record<string, unknown>
): Promise<unknown> {
  const output = await execCommand(client, command(python, helper, operation), {
    input: JSON.stringify(query),
    timeout: requestTimeout,
  });
  if (output.timedOut) throw new Error('The remote Python source request timed out.');
  if (output.code !== 0) {
    throw new Error(output.stderr.trim().slice(-500) || 'The remote Python source request failed.');
  }
  try {
    return JSON.parse(output.stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    throw new Error('The remote Python interpreter returned invalid source information.');
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class LocatorSession {
  private readonly lines: Interface;
  private readonly pending = new Map<number, Pending>();
  private idle?: NodeJS.Timeout;
  private lastId = 0;
  private closed = false;

  constructor(
    private readonly channel: ClientChannel,
    private readonly onClose: () => void
  ) {
    this.lines = createInterface({ input: channel, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.lines.on('error', error => this.close(error));
    this.lines.on('close', () => this.close());
    // Shell and interpreter diagnostics can precede the response.
    channel.stderr.resume();
    channel.on('error', error => this.close(error));
    channel.stderr.on('error', error => this.close(error));
    channel.once('close', () => this.close());
    this.armIdle();
  }

  request(query: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The remote Python source session closed.'));
    clearTimeout(this.idle);
    const id = ++this.lastId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error('The remote Python source request timed out.')),
        requestTimeout
      );
      this.pending.set(id, { resolve, reject, timer });
      this.channel.write(JSON.stringify({ id, query }) + '\n', error => {
        if (error) this.close(error);
      });
    });
  }

  close(error = new Error('The remote Python source session closed.')): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.lines.close();
    this.channel.end();
    this.channel.close();
    this.onClose();
  }

  private armIdle(): void {
    this.idle = setTimeout(() => this.close(), idleTimeout);
    this.idle.unref();
  }

  private receive(line: string): void {
    if (!line.startsWith(framePrefix)) return;
    let response: unknown;
    try {
      response = JSON.parse(line.slice(framePrefix.length));
    } catch {
      this.close(new Error('The remote Python source session returned invalid JSON.'));
      return;
    }
    if (!isRecord(response) || typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    if (!this.pending.size) this.armIdle();
    request.resolve(response.result);
  }
}

interface LocatorConnection {
  client: Client;
  session: Promise<LocatorSession>;
}

export class SourceLocator {
  private readonly sessions = new Map<string, LocatorConnection>();
  private closed = false;

  async locate(
    key: string,
    client: Client,
    python: string,
    helper: string,
    query: Record<string, unknown>,
    isCurrent: () => boolean,
    timing: (mode: string) => void
  ): Promise<unknown> {
    if (this.closed || !isCurrent()) return;
    let entry = this.sessions.get(key);
    const reuse = entry?.client === client;
    if (!reuse) {
      void entry?.session.then(
        session => session.close(),
        () => {}
      );
      const remove = () => {
        if (this.sessions.get(key) === entry) this.sessions.delete(key);
      };
      const session = openChannel(client, command(python, helper, 'serve')).then(channel => {
        const worker = new LocatorSession(channel, remove);
        if (this.closed || this.sessions.get(key) !== entry) worker.close();
        return worker;
      });
      entry = { client, session };
      this.sessions.set(key, entry);
      void session.catch(remove);
    }
    try {
      const session = await entry!.session;
      if (this.closed || !isCurrent()) return;
      const result = await session.request(query);
      timing(reuse ? 'reused' : 'started');
      return result;
    } catch {
      if (this.closed || !isCurrent()) return;
      try {
        return await inspectOnce(client, python, helper, 'locate', query);
      } finally {
        timing('one-shot fallback');
      }
    }
  }

  dispose(): void {
    this.closed = true;
    for (const { session } of this.sessions.values()) {
      void session.then(
        worker => worker.close(),
        () => {}
      );
    }
    this.sessions.clear();
  }
}
