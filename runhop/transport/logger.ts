import type { OutputChannel, SecretStorage } from 'vscode';

let output: OutputChannel | undefined;
let secrets: SecretStorage | undefined;

export function initializeTransport(log: OutputChannel, storage: SecretStorage): void {
  output = log;
  secrets = storage;
}

export function getSecrets(): SecretStorage | undefined {
  return secrets;
}

export function showLog(): void {
  output?.show(true);
}

function write(level: string, ...parts: unknown[]): void {
  output?.appendLine(
    '[' +
      level +
      '] ' +
      parts
        .map(part => (part instanceof Error ? (part.stack ?? part.message) : String(part)))
        .join(' ')
  );
}

export default {
  debug: (...parts: unknown[]) => write('debug', ...parts),
  info: (...parts: unknown[]) => write('info', ...parts),
  warn: (...parts: unknown[]) => write('warn', ...parts),
  error: (...parts: unknown[]) => write('error', ...parts),
};
