export interface DebugMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
  message?: string;
}

const headerEnd = Buffer.from('\r\n\r\n');
const maxPayload = 16 * 1024 * 1024;

export function encodeMessage(message: DebugMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from('Content-Length: ' + payload.length + '\r\n\r\n'), payload]);
}

export class DebugMessageReader {
  private pending = Buffer.alloc(0);
  private payloadLength: number | undefined;

  push(chunk: Buffer, onMessage: (message: DebugMessage) => void): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length) {
      if (this.payloadLength === undefined) {
        const end = this.pending.indexOf(headerEnd);
        if (end < 0 && this.pending.length <= 1024) {
          return;
        }
        const header = end >= 0 ? this.pending.subarray(0, end).toString('ascii') : '';
        const size = Number(/^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1]);
        if (end > 1024 || !Number.isSafeInteger(size) || size <= 0 || size > maxPayload) {
          throw new Error(
            'Invalid debugger output. Check for print commands in the remote shell startup.'
          );
        }
        this.payloadLength = size;
        this.pending = this.pending.subarray(end + headerEnd.length);
      }
      if (this.pending.length < this.payloadLength) {
        return;
      }
      const message: DebugMessage = JSON.parse(
        this.pending.subarray(0, this.payloadLength).toString('utf8')
      );
      this.pending = this.pending.subarray(this.payloadLength);
      this.payloadLength = undefined;
      if (!message || !['request', 'response', 'event'].includes(message.type)) {
        throw new Error('The remote debugger sent an invalid protocol message.');
      }
      onMessage(message);
    }
  }
}
