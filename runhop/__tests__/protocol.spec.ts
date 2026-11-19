import { DebugMessage, DebugMessageReader, encodeMessage } from '../protocol';

describe('RunHop debugger framing', () => {
  test('reads split headers and UTF-8 bodies and emits coalesced messages', () => {
    const first: DebugMessage = {
      seq: 1,
      type: 'event',
      event: 'output',
      body: { output: '图片 ✓' },
    };
    const second: DebugMessage = { seq: 2, type: 'event', event: 'terminated' };
    const bytes = Buffer.concat([encodeMessage(first), encodeMessage(second)]);
    const reader = new DebugMessageReader();
    const seen: DebugMessage[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      reader.push(bytes.subarray(offset, offset + 7), message => seen.push(message));
    }
    expect(seen).toEqual([first, second]);
  });

  test('rejects invalid framing and oversized messages immediately', () => {
    for (const header of [
      'unexpected shell output\r\n\r\n',
      'Content-Length: 17000000\r\n\r\n',
      'Content-Length: -1\r\n\r\n',
    ]) {
      const reader = new DebugMessageReader();
      expect(() => reader.push(Buffer.from(header), jest.fn())).toThrow('Invalid debugger output');
    }
  });
});
