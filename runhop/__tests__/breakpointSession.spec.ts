import { BreakpointSession } from '../breakpointSession';
import type { DebugMessage } from '../protocol';

const file = '/workspace/train.py';
function request(seq: number, condition: string): DebugMessage {
  return {
    seq,
    type: 'request',
    command: 'setBreakpoints',
    arguments: { source: { path: file }, breakpoints: [{ line: 8, column: 1, condition }] },
  };
}
function response(seq: number, id: number, verified: boolean): DebugMessage {
  return {
    seq: seq + 30,
    type: 'response',
    request_seq: seq,
    success: true,
    body: { breakpoints: [{ id, verified }] },
  };
}

it('only associates validation with the latest request and its current breakpoint properties', () => {
  const session = new BreakpointSession();
  session.request(request(1, 'old'));
  session.request(request(2, 'new'));
  expect(session.response(response(2, 20, true))).toBe(true);
  expect(session.response(response(1, 10, false))).toBe(false);
  expect(session.source(file, 8, 1, { condition: 'old' })).toBeUndefined();
  expect(session.source(file, 8, 1, { condition: 'new' })).toEqual({ id: 20, verified: true });
  expect(session.source(file, 8, 4, { condition: 'new' })).toBeUndefined();
});

it('clears departed session status while another session keeps its own status', () => {
  const first = new BreakpointSession();
  const second = new BreakpointSession();
  const line = request(1, 'shared');
  first.request(line);
  second.request(line);
  first.response(response(1, 3, true));
  second.response(response(1, 3, false));
  first.clear();
  expect(first.event('changed', { id: 3, verified: true })).toBe(false);
  expect(first.accept(line, [{ id: 3, verified: true }])).toBe(false);
  expect(first.source(file, 8, 1, { condition: 'shared' })).toBeUndefined();
  expect(second.source(file, 8, 1, { condition: 'shared' })?.verified).toBe(false);
});

it('correlates session exception overrides with the latest native settings', () => {
  const session = new BreakpointSession();
  const original: DebugMessage = {
    seq: 1,
    type: 'request',
    command: 'setExceptionBreakpoints',
    arguments: { filters: ['uncaught'] },
  };
  session.request(original);
  session.response(response(1, 0, true));
  const override = { ...original, arguments: { filters: ['uncaught', 'raised'] } };
  expect(session.accept(override, undefined, true)).toBe(true);
  expect(session.exceptionOverride).toBe(true);
  expect(session.exceptions?.has('raised')).toBe(true);
  session.request({ ...original, seq: 2 });
  session.response(response(2, 0, true));
  expect(session.accept(override, undefined, true)).toBe(false);
  expect(session.exceptionOverride).toBe(false);
  expect(session.exceptions).toEqual(new Set(['uncaught']));
});

it('correlates function breakpoint verification when an adapter reports it', () => {
  const session = new BreakpointSession();
  session.request({
    seq: 1,
    type: 'request',
    command: 'setFunctionBreakpoints',
    arguments: { breakpoints: [{ name: 'train' }] },
  });
  session.response(response(1, 2, true));
  expect(session.function('train', {})?.verified).toBe(true);
  expect(session.function('evaluate', {})).toBeUndefined();
});
