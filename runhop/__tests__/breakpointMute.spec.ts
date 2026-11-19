import { BreakpointMute } from '../breakpointMute';
import type { DebugMessage } from '../protocol';

const line: DebugMessage = {
  seq: 1,
  type: 'request',
  command: 'setBreakpoints',
  arguments: {
    source: { path: '/project/example.py' },
    breakpoints: [{ line: 8, condition: 'ready' }],
  },
};
const exception: DebugMessage = {
  seq: 2,
  type: 'request',
  command: 'setExceptionBreakpoints',
  arguments: { filters: ['uncaught'], filterOptions: [{ filterId: 'uncaught' }] },
};

it('mutes and restores source and exception requests without modifying the original settings', async () => {
  const apply = jest.fn(async (_request: DebugMessage, _muted: boolean) => {});
  const controller = new BreakpointMute(apply);
  controller.track(line);
  controller.track(exception);
  await controller.setMuted(true);
  expect(apply.mock.calls.map(([request]) => request.arguments)).toEqual([
    { source: { path: '/project/example.py' }, breakpoints: [], lines: [] },
    { filters: [], filterOptions: [], exceptionOptions: [] },
  ]);

  const edited = { ...line, arguments: { ...line.arguments, breakpoints: [{ line: 12 }] } };
  expect(controller.track(edited).arguments?.breakpoints).toEqual([]);
  await controller.setMuted(false);
  expect(apply.mock.calls.slice(2)).toEqual([
    [edited, false],
    [exception, false],
  ]);
  expect(line.arguments?.breakpoints).toEqual([{ line: 8, condition: 'ready' }]);
});

it('restores accepted settings after a rejected mute and leaves other sessions independent', async () => {
  const apply = jest.fn(async (_request: DebugMessage, muted: boolean) => {
    if (muted) throw new Error('rejected');
  });
  const controller = new BreakpointMute(apply);
  const other = new BreakpointMute(apply);
  controller.track(line);
  await expect(controller.setMuted(true)).rejects.toThrow('previous settings were restored');
  expect(apply).toHaveBeenLastCalledWith(line, false);
  expect(controller.track(line)).toBe(line);
  expect(other.track(exception)).toBe(exception);
});

it('applies temporary exception filters only to that connection and restores them after mute', async () => {
  const apply = jest.fn(async (_request: DebugMessage, _muted: boolean) => {});
  const controller = new BreakpointMute(apply);
  const other = new BreakpointMute(apply);
  controller.track(exception);
  other.track(exception);

  const override = await controller.setExceptionFilter('raised', true);
  expect(override?.arguments).toEqual({
    filters: ['uncaught', 'raised'],
    filterOptions: [{ filterId: 'uncaught' }],
  });
  await controller.setMuted(true);
  await controller.setMuted(false);
  expect(apply).toHaveBeenLastCalledWith(override, false);
  await other.setMuted(true);
  await other.setMuted(false);
  expect(apply).toHaveBeenLastCalledWith(exception, false);
  expect(controller.track(exception)).toBe(exception);
  expect(controller.isCurrent(override!)).toBe(false);
});

it('keeps the previous filters after a rejected exception update', async () => {
  const apply = jest.fn(async (request: DebugMessage) => {
    if ((request.arguments?.filters as string[]).includes('raised')) {
      throw new Error('adapter refused');
    }
  });
  const controller = new BreakpointMute(apply);
  controller.track(exception);
  await expect(controller.setExceptionFilter('raised', true)).rejects.toThrow('adapter refused');
  expect(apply).toHaveBeenLastCalledWith(exception, false);
});

it('keeps newer native filters when a temporary exception update is in flight', async () => {
  let confirm!: () => void;
  const controller = new BreakpointMute(
    () =>
      new Promise<void>(resolve => {
        confirm = resolve;
      })
  );
  controller.track(exception);
  const inFlight = controller.setExceptionFilter('raised', true);
  const native: DebugMessage = {
    ...exception,
    seq: 3,
    arguments: { filters: ['userUnhandled'] },
  };
  expect(controller.track(native)).toBe(native);
  confirm();
  await expect(inFlight).resolves.toBeUndefined();
  expect(controller.isCurrent(native)).toBe(true);
});
