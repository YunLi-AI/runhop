// The SSH connection pool is based on SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/remoteFs.ts

import { window } from 'vscode';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServiceConfig } from './config';
import { connectionIdentity } from './connectionIdentity';
import { SFTPFileSystem } from './fs';
import { ErrorCode } from './remote-client/remoteClient';
import { HostKeyError } from './remote-client/hostKeyVerifier';
import hostKeyPrompt from '../hostKeyPrompt';
import logger from '../logger';

function makeRemote(config: ServiceConfig) {
  return new SFTPFileSystem(path.posix, {
    clientOption: config.connection,
    remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
    operationTimeout: config.operationTimeout,
  });
}

export class BackgroundAuthenticationRequired extends Error {}

export class SourceConnectionError extends Error {
  constructor(
    readonly host: string,
    readonly attempts: number,
    readonly cause: Error
  ) {
    super(cause.message);
  }
}

const requireUser = async () => {
  throw new BackgroundAuthenticationRequired('SSH authentication requires user input.');
};

function authenticate(
  fs: SFTPFileSystem,
  config: ServiceConfig,
  background = false
): Promise<void> {
  return fs.connect(config.connection, {
    askForPasswd: background
      ? requireUser
      : prompt =>
          Promise.resolve(window.showInputBox({ prompt, password: true, ignoreFocusOut: true })),
    hostKeyPrompt: background
      ? { confirmUnknownHost: requireUser, reportChangedHostKey: () => {} }
      : hostKeyPrompt,
  });
}

export async function withRemoteProbe<T>(
  config: ServiceConfig,
  probe: (fs: SFTPFileSystem) => Promise<T>
): Promise<T> {
  const fs = makeRemote(config);
  // A failed probe must never disconnect a running session in the connection pool.
  fs.onDisconnected(() => {});
  try {
    await authenticate(fs, config);
    return await probe(fs);
  } finally {
    fs.end();
  }
}

class Connection {
  private fs?: SFTPFileSystem;
  private acquiring?: Promise<SFTPFileSystem>;
  private sourceAcquiring?: Promise<SFTPFileSystem>;
  private shared?: SFTPFileSystem;
  private sourceUses = 0;
  private sourceIdle?: NodeJS.Timeout;
  private sourceIdleMs = 0;
  private lastSourceUse = 0;
  private lastUsed = 0;
  private closed = false;

  async get(config: ServiceConfig): Promise<SFTPFileSystem> {
    clearTimeout(this.sourceIdle);
    let fs: SFTPFileSystem;
    try {
      fs = await this.connect(config, false);
    } catch (error) {
      // The regular command may have joined a background handshake that needs input.
      if (!(error instanceof BackgroundAuthenticationRequired)) throw error;
      fs = await this.connect(config, false);
    }
    this.shared = fs;
    clearTimeout(this.sourceIdle);
    return fs;
  }

  async useForSource<T>(
    config: ServiceConfig,
    idleMs: number,
    background: boolean,
    work: (fs: SFTPFileSystem) => Promise<T>
  ): Promise<T> {
    this.sourceUses++;
    this.sourceIdleMs = idleMs;
    clearTimeout(this.sourceIdle);
    try {
      let fs: SFTPFileSystem;
      try {
        fs = await this.connectForSource(config, background);
      } catch (error) {
        if (background || !(error instanceof BackgroundAuthenticationRequired)) throw error;
        fs = await this.connectForSource(config, false);
      }
      return await work(fs);
    } finally {
      this.sourceUses--;
      this.lastSourceUse = Date.now();
      this.armSourceIdle();
    }
  }

  private connectForSource(config: ServiceConfig, background: boolean): Promise<SFTPFileSystem> {
    return (this.sourceAcquiring ??= this.retrySource(config, background).finally(() => {
      this.sourceAcquiring = undefined;
    }));
  }

  private async retrySource(config: ServiceConfig, background: boolean): Promise<SFTPFileSystem> {
    const retryDelays = [250, 500, 1000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connect(config, background);
      } catch (error) {
        if (this.closed || error instanceof BackgroundAuthenticationRequired) throw error;
        if (error.code === ErrorCode.CONNECT_CANCELLED) throw error;
        if (
          attempt === retryDelays.length ||
          error instanceof HostKeyError ||
          error.level === 'client-authentication'
        ) {
          throw new SourceConnectionError(config.host, attempt + 1, error);
        }
        logger.debug(
          'Retrying source SSH connection to ' + config.host + ' (' + (attempt + 1) + ')'
        );
        await delay(retryDelays[attempt]);
      }
    }
  }

  updateSourceIdle(idleMs: number): void {
    if (this.sourceIdleMs === idleMs) return;
    this.sourceIdleMs = idleMs;
    this.armSourceIdle();
  }

  private armSourceIdle(): void {
    const fs = this.fs;
    if (!fs || this.shared === fs || this.closed || this.sourceUses > 0) return;
    clearTimeout(this.sourceIdle);
    this.sourceIdle = setTimeout(
      () => {
        if (this.fs === fs && this.shared !== fs && this.sourceUses === 0) {
          this.fs = undefined;
          fs.end();
        }
      },
      Math.max(0, this.lastSourceUse + this.sourceIdleMs - Date.now())
    );
    this.sourceIdle.unref();
  }

  private connect(config: ServiceConfig, background: boolean): Promise<SFTPFileSystem> {
    if (!this.acquiring) {
      this.acquiring = this.acquire(config, background).finally(() => {
        this.acquiring = undefined;
      });
    }
    return this.acquiring;
  }

  private async acquire(config: ServiceConfig, background: boolean): Promise<SFTPFileSystem> {
    const current = this.fs;
    if (current && config.idleTimeout > 0 && Date.now() - this.lastUsed >= config.idleTimeout) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          current.probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('SSH connection timed out')),
              config.connectTimeout || 10_000
            );
          }),
        ]);
      } catch {
        if (this.fs === current) {
          this.fs = undefined;
          this.shared = undefined;
          current.end();
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (this.closed) {
      throw new Error('RunHop SSH connection was closed.');
    }
    if (!this.fs) {
      const fs = makeRemote(config);
      this.fs = fs;
      fs.onDisconnected((reason: string, error?: Error) => {
        if (this.fs === fs) {
          this.fs = undefined;
          this.shared = undefined;
          clearTimeout(this.sourceIdle);
          if (error) {
            logger.warn('SSH ' + reason, error.message);
          }
          fs.end();
        }
      });
      try {
        await authenticate(fs, config, background);
        if (this.fs !== fs || this.closed) {
          throw new Error('SSH connection closed during startup.');
        }
      } catch (error) {
        if (this.fs === fs) {
          this.fs = undefined;
        }
        fs.end();
        throw error;
      }
    }
    this.lastUsed = Date.now();
    return this.fs;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.sourceIdle);
    const fs = this.fs;
    this.fs = undefined;
    this.shared = undefined;
    fs?.end();
  }
}

const connections = new Map<string, Connection>();

function poolKey(config: ServiceConfig): string {
  return connectionIdentity({
    ...config.connection,
    operationTimeout: config.operationTimeout,
    remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
  });
}

function pooledConnection(config: ServiceConfig): Connection {
  const identity = poolKey(config);
  let connection = connections.get(identity);
  if (!connection) {
    connection = new Connection();
    connections.set(identity, connection);
  }
  return connection;
}

export function createRemoteIfNoneExist(config: ServiceConfig): Promise<SFTPFileSystem> {
  return pooledConnection(config).get(config);
}

export function withSourceRemote<T>(
  config: ServiceConfig,
  idleMs: number,
  background: boolean,
  work: (fs: SFTPFileSystem) => Promise<T>
): Promise<T> {
  return pooledConnection(config).useForSource(config, idleMs, background, work);
}

export function updateSourceRemoteIdle(config: ServiceConfig, idleMs: number): void {
  connections.get(poolKey(config))?.updateSourceIdle(idleMs);
}

export function removeAllRemoteFs(): void {
  for (const connection of connections.values()) {
    connection.close();
  }
  connections.clear();
}
