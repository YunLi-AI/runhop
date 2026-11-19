// The SSH connection pool is based on SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/remoteFs.ts

import { window } from 'vscode';
import path from 'node:path';
import type { ServiceConfig } from './config';
import { connectionIdentity } from './connectionIdentity';
import { SFTPFileSystem } from './fs';
import hostKeyPrompt from '../hostKeyPrompt';
import logger from '../logger';

class Connection {
  private fs?: SFTPFileSystem;
  private acquiring?: Promise<SFTPFileSystem>;
  private lastUsed = 0;
  private closed = false;

  get(config: ServiceConfig): Promise<SFTPFileSystem> {
    if (!this.acquiring) {
      this.acquiring = this.acquire(config).finally(() => {
        this.acquiring = undefined;
      });
    }
    return this.acquiring;
  }

  private async acquire(config: ServiceConfig): Promise<SFTPFileSystem> {
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
      const fs = new SFTPFileSystem(path.posix, {
        clientOption: config.connection,
        remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
        operationTimeout: config.operationTimeout,
      });
      this.fs = fs;
      fs.onDisconnected((reason: string, error?: Error) => {
        if (this.fs === fs) {
          this.fs = undefined;
          if (error) {
            logger.warn('SSH ' + reason, error.message);
          }
          fs.end();
        }
      });
      try {
        await fs.connect(config.connection, {
          askForPasswd: prompt =>
            Promise.resolve(window.showInputBox({ prompt, password: true, ignoreFocusOut: true })),
          hostKeyPrompt,
        });
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
    const fs = this.fs;
    this.fs = undefined;
    fs?.end();
  }
}

const connections = new Map<string, Connection>();

export function createRemoteIfNoneExist(config: ServiceConfig): Promise<SFTPFileSystem> {
  const identity = connectionIdentity({
    ...config.connection,
    operationTimeout: config.operationTimeout,
    remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
  });
  let connection = connections.get(identity);
  if (!connection) {
    connection = new Connection();
    connections.set(identity, connection);
  }
  return connection.get(config);
}

export function removeAllRemoteFs(): void {
  for (const connection of connections.values()) {
    connection.close();
  }
  connections.clear();
}
