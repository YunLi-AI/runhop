import type { Client, ClientChannel } from 'ssh2';

export const startupTimeout = 20_000;
export const shutdownTimeout = 5_000;

export function openChannel(
  client: Client,
  command: string,
  interactive = false
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error('Timed out opening a session on the SSH server.'));
    }, startupTimeout);
    const pty = interactive ? { term: 'xterm-256color', rows: 24, cols: 80 } : false;
    client.exec(command, { pty }, (error, channel) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else if (expired) {
        channel.end();
        channel.close();
      } else {
        resolve(channel);
      }
    });
  });
}
