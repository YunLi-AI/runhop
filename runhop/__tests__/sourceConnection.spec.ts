import type { ServiceConfig } from '../transport/core/config';
import {
  BackgroundAuthenticationRequired,
  createRemoteIfNoneExist,
  removeAllRemoteFs,
  updateSourceRemoteIdle,
  withSourceRemote,
} from '../transport/core/remoteFs';

const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockPrompt = jest.fn();
jest.mock('vscode', () => ({
  window: { showInputBox: (...args: unknown[]) => mockPrompt(...args) },
}));
jest.mock('../transport/hostKeyPrompt', () => ({}));
jest.mock('../transport/core/fs', () => ({
  SFTPFileSystem: class {
    connect = mockConnect;
    end = mockEnd;
    onDisconnected() {}
  },
}));
jest.mock('node:timers/promises', () => ({
  setTimeout: (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)),
}));

const config = {
  host: 'source.example',
  connection: { host: 'source.example', port: 22, username: 'dev' },
} as ServiceConfig;
const noWork = async () => {};

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockPrompt.mockReset().mockResolvedValue(undefined);
  jest.useFakeTimers();
});

afterEach(() => {
  removeAllRemoteFs();
  jest.useRealTimers();
});

test('reuses preconnected SSH, extends idle time on use and reconnects after expiry', async () => {
  await withSourceRemote(config, 300_000, true, noWork);
  await jest.advanceTimersByTimeAsync(299_000);
  await withSourceRemote(config, 300_000, false, noWork);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(299_000);
  expect(mockEnd).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(mockEnd).toHaveBeenCalledTimes(1);
  await withSourceRemote(config, 300_000, false, noWork);
  expect(mockConnect).toHaveBeenCalledTimes(2);
});

test('applies a new idle timeout and defers closing while a read is active', async () => {
  await withSourceRemote(config, 600_000, true, noWork);
  let finish = noWork;
  const reading = withSourceRemote(
    config,
    600_000,
    false,
    () =>
      new Promise<void>(resolve => {
        finish = async () => resolve();
      })
  );
  await jest.advanceTimersByTimeAsync(600_000);
  updateSourceRemoteIdle(config, 300_000);
  expect(mockEnd).not.toHaveBeenCalled();
  await finish();
  await reading;
  await jest.advanceTimersByTimeAsync(300_000);
  expect(mockEnd).toHaveBeenCalledTimes(1);
});

test('preserves a warmed connection adopted by Run, Debug, terminal or transfers', async () => {
  await withSourceRemote(config, 300_000, true, noWork);
  await createRemoteIfNoneExist(config);
  await withSourceRemote(config, 300_000, false, noWork);
  await jest.advanceTimersByTimeAsync(600_000);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockEnd).not.toHaveBeenCalled();
});

test('shares three retries, then lets the next click connect from scratch', async () => {
  mockConnect.mockRejectedValue(new Error('connection refused'));
  const warming = withSourceRemote(config, 300_000, true, noWork).catch(error => error);
  const opening = withSourceRemote(config, 300_000, false, noWork).catch(error => error);
  await jest.advanceTimersByTimeAsync(1750);
  const error = await warming;
  expect(await opening).toBe(error);
  expect(error).toMatchObject({ message: 'connection refused', attempts: 4 });
  expect(mockConnect).toHaveBeenCalledTimes(4);
  mockConnect.mockResolvedValue(undefined);
  await withSourceRemote(config, 300_000, false, noWork);
  expect(mockConnect).toHaveBeenCalledTimes(5);
});

test('defers interactive authentication until a source is actually opened', async () => {
  mockPrompt.mockResolvedValue('fixture');
  mockConnect.mockImplementation(async (_option, auth) => {
    await auth.askForPasswd('SSH prompt');
  });
  await expect(withSourceRemote(config, 300_000, true, noWork)).rejects.toBeInstanceOf(
    BackgroundAuthenticationRequired
  );
  expect(mockPrompt).not.toHaveBeenCalled();
  await withSourceRemote(config, 300_000, false, noWork);
  expect(mockPrompt).toHaveBeenCalledTimes(1);
});
