import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as debuggerHelper from '../debuggerHelper';
import { createIncrementalSync } from '../incrementalSync';
import { registerSaveUploads } from '../saveUploads';
import * as settings from '../settings';
import * as targets from '../targets';
import * as remoteExec from '../transport/core/remote-client/exec';
import * as transfers from '../transfers';

jest.mock('vscode');

function mockSaveEvents(workspace: string) {
  const disposable = { dispose() {} };
  const onDidSaveTextDocument = jest.fn(
    (_listener: (doc: vscode.TextDocument) => void) => disposable
  );
  const showWarningMessage = jest.fn();
  Object.assign(vscode, {
    env: {},
    window: { showWarningMessage },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      getWorkspaceFolder: () => ({ uri: { fsPath: workspace } }),
      onDidSaveTextDocument,
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable,
        onDidChange: () => disposable,
        onDidDelete: () => disposable,
        dispose() {},
      }),
    },
  });
  return {
    showWarningMessage,
    save(file: string) {
      onDidSaveTextDocument.mock.calls[0][0]({
        uri: { scheme: 'file', fsPath: file },
      } as vscode.TextDocument);
    },
  };
}

test('retries a file changed before publishing and uploads the latest saved contents', async () => {
  const workspace = await mkdtemp(path.join(await realpath(tmpdir()), 'runhop-save-'));
  const subscriptions: vscode.Disposable[] = [];
  try {
    const relative = 'script.py';
    const file = path.join(workspace, relative);
    const latest = 'newly saved contents\n';
    const sshConfigPath = path.join(workspace, 'ssh-config');
    await writeFile(sshConfigPath, '');
    await writeFile(file, 'first save\n');
    const connections = [
      { host: 'source.example', username: 'dev', remotePath: '/remote', sshConfigPath },
    ];
    jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue({
      targets: connections,
      uploadOnSave: true,
      uploadPolicy: 'safe',
    });
    const key = transfers.projectTransferKey(targets.resolveTarget(connections, workspace, file));

    const { save, showWarningMessage } = mockSaveEvents(workspace);

    type Finished = Parameters<transfers.ProjectTransfer['onFinished']>[0];
    let onFinished: Finished | undefined;
    jest.spyOn(transfers, 'projectTransfer').mockImplementation(target => ({
      ...target,
      onFinished(listener) {
        onFinished = listener;
        return {
          dispose: () => {
            onFinished = undefined;
          },
        };
      },
      dispose() {},
    }));
    jest.spyOn(targets, 'connectSsh').mockResolvedValue({
      fs: { ensureDir: async () => {} },
      client: { getRawClient: () => ({}) },
    } as unknown as Awaited<ReturnType<typeof targets.connectSsh>>);
    jest.spyOn(debuggerHelper, 'resolveRemotePath').mockResolvedValue('/remote');

    let staged = '';
    let remote = '';
    const remoteCommand = jest
      .spyOn(remoteExec, 'execCommand')
      .mockImplementation(async (_client, _command, options) => {
        const input = JSON.parse(options!.input!);
        let response: unknown = [null];
        if (!Array.isArray(input[0])) {
          expect(input).toEqual([
            relative,
            '/remote/staging',
            null,
            createHash('sha256').update(staged).digest('hex'),
          ]);
          remote = staged;
          response = '1:6:7:8:9';
        }
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify(response),
          stderr: '',
          timedOut: false,
        };
      });
    const upload = jest
      .spyOn(transfers, 'uploadSourceFiles')
      .mockImplementation(async (_project, files, options) => {
        expect(files).toEqual([file]);
        staged = await readFile(file, 'utf8');
        if (staged === 'first save\n') await writeFile(file, latest);
        try {
          await options!.publish!(file, '/remote/staging', '/remote/script.py');
        } catch (error) {
          const task = {
            srcFsPath: file,
            isCancelled: () => false,
          } as Parameters<Finished>[0]['task'];
          onFinished!({ task, error });
          throw error;
        }
        return files.length;
      });

    const appendLine = jest.fn();
    const uploads = registerSaveUploads(
      { subscriptions } as vscode.ExtensionContext,
      { appendLine } as unknown as vscode.OutputChannel,
      async (_key, transfer) => transfer(),
      (_key, outputs) => outputs,
      createIncrementalSync()
    );
    save(file);
    await expect(uploads.wait(workspace, key)).resolves.toBeUndefined();

    expect(upload).toHaveBeenCalledTimes(2);
    expect(remoteCommand).toHaveBeenCalledTimes(3);
    expect(remote).toBe(latest);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Retrying 2/3'));
    expect(showWarningMessage).not.toHaveBeenCalled();
  } finally {
    for (const item of subscriptions) item.dispose();
    jest.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('force upload publishes complete saved versions in order and debug waits for the latest save', async () => {
  const fixture = await mkdtemp(path.join(await realpath(tmpdir()), 'runhop-force-save-'));
  const subscriptions: vscode.Disposable[] = [];
  const workspace = path.join(fixture, 'local');
  const remote = path.join(fixture, 'remote');
  try {
    const name = 'script.py';
    const file = path.join(workspace, name);
    const destination = path.join(remote, name);
    const sshConfigPath = path.join(fixture, 'ssh-config');
    const first = 'saved version A\n';
    const latest = 'saved version B with a different size\n';
    await mkdir(workspace);
    await mkdir(remote);
    await writeFile(file, first);
    await writeFile(destination, 'remote contents\n');
    await writeFile(sshConfigPath, '');
    const connections = [
      { host: 'source.example', username: 'dev', remotePath: remote, sshConfigPath },
    ];
    jest.spyOn(settings, 'readOptionalSettings').mockResolvedValue({
      targets: connections,
      uploadOnSave: true,
      uploadPolicy: 'force_upload',
    });
    const target = targets.resolveTarget(connections, workspace, file);
    const key = transfers.projectTransferKey(target);
    const fs = target.service.getLocalFileSystem();
    jest.spyOn(targets, 'connectSsh').mockResolvedValue({
      fs,
      client: { getRawClient: () => ({}) },
    } as unknown as Awaited<ReturnType<typeof targets.connectSsh>>);
    jest.spyOn(debuggerHelper, 'resolveRemotePath').mockResolvedValue(remote);
    const { save, showWarningMessage } = mockSaveEvents(workspace);
    class EventEmitter<T> {
      private listeners = new Set<(event: T) => void>();
      event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(event: T) {
        this.listeners.forEach(listener => listener(event));
      }
      dispose() {
        this.listeners.clear();
      }
    }
    Object.assign(vscode, { EventEmitter });

    const published: string[] = [];
    const remoteCommand = jest
      .spyOn(remoteExec, 'execCommand')
      .mockImplementation(async (_client, _command, options) => {
        const input = JSON.parse(options!.input!);
        if (Array.isArray(input[0])) {
          throw new Error('Force upload should not inspect the remote contents');
        }
        const [relative, staging, expected, digest] = input;
        expect([relative, expected, digest]).toEqual([name, null, null]);
        expect(path.dirname(staging)).toBe(remote);
        expect(await readFile(destination, 'utf8')).toBe(published.at(-1) ?? 'remote contents\n');
        await rename(staging, destination);
        published.push(await readFile(destination, 'utf8'));
        const info = await lstat(destination, { bigint: true });
        const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify(fingerprint),
          stderr: '',
          timedOut: false,
        };
      });
    const put = fs.put.bind(fs);
    jest.spyOn(fs, 'put').mockImplementationOnce(async (...args) => {
      await writeFile(file, latest);
      save(file);
      await put(...args);
    });

    let tail = Promise.resolve();
    const incremental = createIncrementalSync();
    const uploads = registerSaveUploads(
      { subscriptions } as vscode.ExtensionContext,
      { appendLine: jest.fn() } as unknown as vscode.OutputChannel,
      (_key, transfer) => {
        const task = tail.then(transfer);
        tail = task.catch(() => {});
        return task;
      },
      (_key, outputs) => outputs,
      incremental
    );
    save(file);
    await uploads.wait(workspace, key);
    expect(published).toEqual([first, latest]);
    expect(remoteCommand).toHaveBeenCalledTimes(2);
    expect(uploads.changedFiles(workspace, workspace)).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    const project = transfers.projectTransfer(target);
    subscriptions.push(project);
    expect(await incremental.hasBaseline(project)).toBe(false);

    const lastPublish = await remoteCommand.mock.results.at(-1)!.value;
    remoteCommand.mockResolvedValueOnce({
      ...lastPublish,
      stdout: JSON.stringify([{ fingerprint: JSON.parse(lastPublish.stdout) }]),
    });
    const cancellation = new vscode.CancellationTokenSource();
    subscriptions.push(cancellation);
    await expect(
      incremental.sync(project, [], 'python3', cancellation.token, () => {})
    ).resolves.toMatchObject({ uploaded: 0, conflicts: [] });
    expect(await incremental.hasBaseline(project)).toBe(true);

    remoteCommand.mockResolvedValueOnce({ ...lastPublish, code: 1, stderr: 'Permission denied' });
    await writeFile(file, 'save whose upload fails\n');
    save(file);
    await expect(uploads.wait(workspace, key)).rejects.toThrow('Permission denied');
    expect(await readFile(destination, 'utf8')).toBe(latest);
    expect(await readdir(remote)).toEqual([name]);
  } finally {
    for (const item of subscriptions) item.dispose();
    jest.restoreAllMocks();
    await rm(fixture, { recursive: true, force: true });
  }
});
