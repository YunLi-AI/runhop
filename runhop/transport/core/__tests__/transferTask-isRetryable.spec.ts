// Adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/__tests__/transferTask-isRetryable-test.ts

import { isRetryable } from '../transferTask';

function errorWith(props: object, message = 'transfer failed') {
  return Object.assign(new Error(message), props);
}

describe('isRetryable', () => {
  it('retries transient network errors', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTCONN']) {
      expect(isRetryable(errorWith({ code }))).toBe(true);
    }
  });

  it('does not retry permission or not-found errors', () => {
    expect(isRetryable(errorWith({ code: 'EACCES' }))).toBe(false);
    expect(isRetryable(errorWith({ code: 'ENOENT' }))).toBe(false);
    // SFTP_STATUS_CODE.PERMISSION_DENIED
    expect(isRetryable(errorWith({ code: 3 }))).toBe(false);
  });

  it('retries a server that stopped responding', () => {
    expect(isRetryable(new Error('No response from server'))).toBe(true);
  });

  it('retries an ssh2 channel that went away', () => {
    expect(isRetryable(new Error('Channel closed'))).toBe(true);
    expect(isRetryable(new Error('(SSH) Channel open failure'))).toBe(true);
  });

  it('does not retry permission failures reported only in the message', () => {
    expect(isRetryable(new Error('Permission denied'))).toBe(false);
    expect(isRetryable(new Error('No such file or directory'))).toBe(false);
  });

  it('treats unknown and missing errors as fatal', () => {
    expect(isRetryable(new Error('something we have never seen'))).toBe(false);
    expect(isRetryable(errorWith({ code: 'ESOMETHING' }))).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
