import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { isLocalPathAtOrUnder } from '../paths';
import {
  interpreterFor,
  isRecord,
  readOptionalSettings,
  settingsFile,
  type Settings,
} from '../settings';
import { matchingTargets, projectTargets, resolveTarget } from '../targets';
import { FileType, isNotFoundError, type RemoteFileSystem } from '../transport/core';
import {
  BackgroundAuthenticationRequired,
  SourceConnectionError,
  updateSourceRemoteIdle,
  withSourceRemote,
} from '../transport/core/remoteFs';
import { ErrorCode } from '../transport/core/remote-client/remoteClient';
import { importedReferences, referenceAt, type ImportReference } from './imports';
import { inspectOnce, SourceLocator } from './locator';

const scheme = 'runhop-source';
const storageKey = 'runhop.remoteSources';
const linkCommand = 'runhop.openRemoteSourceLink';
const maxBytes = 8 * 1024 * 1024;
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const normalizedTextDigest = (text: string) =>
  digest(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));

async function localModuleExists(
  module: string,
  workspace: string,
  anchor: string
): Promise<boolean> {
  const name = module.split('.')[0];
  if (!name || /[\\/\0]/.test(name)) return false;
  const roots = [...new Set([path.dirname(anchor), workspace, path.join(workspace, 'src')])];
  const candidates = roots.flatMap(root => [
    { file: path.join(root, name + '.py'), directory: false },
    { file: path.join(root, name), directory: true },
  ]);
  return (
    await Promise.all(
      candidates.map(({ file, directory }) =>
        stat(file).then(
          info => (directory ? info.isDirectory() : info.isFile()),
          () => false
        )
      )
    )
  ).some(Boolean);
}

async function projectDefinitions(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[]> {
  const definitions = await vscode.commands
    .executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      position
    )
    .then(
      result => result ?? [],
      () => []
    );
  const locations: vscode.Location[] = [];
  for (const item of definitions) {
    const uri = 'targetUri' in item ? item.targetUri : item.uri;
    if (uri.scheme !== 'file') continue;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    if (relative.split(path.sep).some(name => /^(site-packages|dist-packages)$/i.test(name))) {
      continue;
    }
    const range =
      'targetUri' in item ? (item.targetSelectionRange ?? item.targetRange) : item.range;
    locations.push(new vscode.Location(uri, range));
  }
  return locations;
}

interface Location {
  path: string;
  line: number;
  module: string;
  package: boolean;
}

interface SourceFile extends Location {
  authority: string;
  workspace: string;
  anchor: string;
  interpreter: string;
}

interface ProjectSource {
  folder: vscode.WorkspaceFolder;
  anchor: string;
  origin?: SourceFile;
  settings?: Settings;
}

type Definition = { locations: vscode.Location[] } | { uri: vscode.Uri; selection: vscode.Range };
type RecordTiming = (label: string, start: number) => void;

function endpoint(
  folder: vscode.WorkspaceFolder,
  anchor: string,
  settings: Settings,
  name: string
) {
  const interpreter = interpreterFor(settings, name)!;
  const target = resolveTarget(
    settings.targets,
    folder.uri.fsPath,
    anchor,
    interpreter.target,
    interpreter.profile
  );
  const authority = digest(
    JSON.stringify([
      folder.uri.fsPath,
      target.service.getConnectionId(target.config),
      interpreter.path,
    ])
  ).slice(0, 24);
  return { name, interpreter, target, authority };
}

type Endpoint = ReturnType<typeof endpoint>;

const sourceSettings = 'runhop.remoteSource';

function sourceIdleMs(folder: vscode.WorkspaceFolder): number {
  const minutes = vscode.workspace
    .getConfiguration(sourceSettings, folder.uri)
    .get('idleMinutes', 5);
  return (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 5) * 60_000;
}

function sourceUri(file: SourceFile): vscode.Uri {
  return vscode.Uri.from({ scheme, authority: file.authority, path: file.path });
}

function validLocation(value: unknown): value is Location {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    path.posix.isAbsolute(value.path) &&
    path.posix.normalize(value.path) === value.path &&
    !value.path.includes('\0') &&
    /\.pyw?$/.test(value.path) &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) > 0 &&
    typeof value.module === 'string' &&
    typeof value.package === 'boolean'
  );
}

function validStoredFile(value: unknown): value is SourceFile {
  return (
    validLocation(value) &&
    isRecord(value) &&
    typeof value.authority === 'string' &&
    /^[a-f0-9]{24}$/.test(value.authority) &&
    typeof value.workspace === 'string' &&
    typeof value.anchor === 'string' &&
    typeof value.interpreter === 'string'
  );
}

function isTrustedLocal(): boolean {
  return vscode.workspace.isTrusted && !vscode.env.remoteName;
}

class RemoteSources implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly files = new Map<string, SourceFile>();
  private readonly revisions = new Map<string, string>();
  private readonly diskReads = new Map<string, { bytes: string; text: string }>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly locator = new SourceLocator();
  private readonly importIndex = new WeakMap<
    vscode.TextDocument,
    { version: number; references: ImportReference[] }
  >();
  private helper?: Promise<string>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    for (const file of context.workspaceState.get<unknown[]>(storageKey, []) ?? []) {
      if (validStoredFile(file)) this.files.set(this.key(sourceUri(file)), file);
    }
  }

  dispose(): void {
    this.locator.dispose();
    this.changes.dispose();
  }

  private script(): Promise<string> {
    return (this.helper ??= readFile(
      this.context.asAbsolutePath('resources/remoteSource.py'),
      'utf8'
    ));
  }

  refreshRevision(document: vscode.TextDocument): void {
    if (document.uri.scheme !== scheme || document.isDirty) return;
    const key = this.key(document.uri);
    const disk = this.diskReads.get(key);
    if (disk && normalizedTextDigest(document.getText()) === disk.text) {
      this.revisions.set(key, disk.bytes);
    }
  }

  private key(uri: vscode.Uri): string {
    return uri.with({ fragment: '', query: '' }).toString();
  }

  private connection<T>(
    current: Endpoint,
    folder: vscode.WorkspaceFolder,
    work: (fs: RemoteFileSystem) => Promise<T>,
    background = false
  ): Promise<T> {
    return withSourceRemote(current.target.config, sourceIdleMs(folder), background, work);
  }

  async defaultEndpoint(
    folder: vscode.WorkspaceFolder,
    anchor: string
  ): Promise<Endpoint | undefined> {
    const workspace = folder.uri.fsPath;
    const settings = await readOptionalSettings(workspace);
    if (!settings?.defaultInterpreter) return;
    const interpreter = interpreterFor(settings, settings.defaultInterpreter)!;
    if (!matchingTargets(settings.targets, workspace, anchor, interpreter.target).length) {
      const candidates = projectTargets(settings.targets, workspace).filter(({ raw }) =>
        interpreter.target ? raw.name === interpreter.target : true
      );
      if (candidates.length !== 1) return;
      anchor = candidates[0].baseDir;
    }
    return endpoint(folder, anchor, settings, settings.defaultInterpreter);
  }

  preconnect(current: Endpoint, folder: vscode.WorkspaceFolder): Promise<void> {
    return this.connection(current, folder, async () => {}, true);
  }

  private async savedEndpoint(
    file: SourceFile
  ): Promise<{ current: Endpoint; folder: vscode.WorkspaceFolder }> {
    const folder = vscode.workspace.workspaceFolders?.find(
      item => item.uri.toString() === file.workspace
    );
    if (!folder || !isLocalPathAtOrUnder(folder.uri.fsPath, file.anchor)) {
      throw vscode.FileSystemError.Unavailable(
        'Open the original RunHop project to access this source file.'
      );
    }
    const settings = await readOptionalSettings(folder.uri.fsPath);
    if (!settings) {
      throw vscode.FileSystemError.Unavailable('The RunHop project configuration is unavailable.');
    }
    const current = endpoint(folder, file.anchor, settings, file.interpreter);
    if (current.authority !== file.authority) {
      throw vscode.FileSystemError.Unavailable(
        'The SSH interpreter changed. Open the definition again.'
      );
    }
    return { current, folder };
  }

  private references(document: vscode.TextDocument): ImportReference[] {
    const old = this.importIndex.get(document);
    if (old?.version === document.version) return old.references;
    const references = importedReferences(document.getText());
    this.importIndex.set(document, { version: document.version, references });
    return references;
  }

  reference(document: vscode.TextDocument, position: vscode.Position): ImportReference | undefined {
    return referenceAt(this.references(document), document.offsetAt(position));
  }

  private async projectSource(document: vscode.TextDocument): Promise<ProjectSource | undefined> {
    if (!isTrustedLocal() || document.languageId !== 'python') return;
    const origin =
      document.uri.scheme === scheme ? this.files.get(this.key(document.uri)) : undefined;
    if (document.uri.scheme !== 'file' && !origin) return;
    const folder = origin
      ? vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === origin.workspace)
      : vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;
    const anchor = origin?.anchor ?? document.uri.fsPath;
    const settings = origin ? undefined : await readOptionalSettings(folder.uri.fsPath);
    return { folder, anchor, origin, settings };
  }

  async enabled(document: vscode.TextDocument): Promise<boolean> {
    const project = await this.projectSource(document);
    return Boolean(project?.origin || project?.settings?.defaultInterpreter);
  }

  async links(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentLink[]> {
    const version = document.version;
    const project = await this.projectSource(document);
    if (
      (!project?.origin && !project?.settings?.defaultInterpreter) ||
      token.isCancellationRequested
    ) {
      return [];
    }
    const references = this.references(document);
    const roots = [
      ...new Set(
        references.filter(ref => !ref.module.startsWith('.')).map(ref => ref.module.split('.')[0])
      ),
    ];
    const local = new Set(
      project.origin
        ? []
        : await Promise.all(
            roots.map(async module =>
              (await localModuleExists(module, project.folder.uri.fsPath, project.anchor))
                ? module
                : ''
            )
          )
    );
    if (document.version !== version || token.isCancellationRequested) return [];
    return references
      .filter(
        ref =>
          project.origin || (!ref.module.startsWith('.') && !local.has(ref.module.split('.')[0]))
      )
      .map(ref => {
        const range = new vscode.Range(document.positionAt(ref.from), document.positionAt(ref.to));
        const link = new vscode.DocumentLink(
          range,
          vscode.Uri.from({
            scheme: 'command',
            path: linkCommand,
            query: JSON.stringify([document.uri.toString(), version, ref.from]),
          })
        );
        link.tooltip = 'Open RunHop SSH source';
        return link;
      });
  }

  async definition(
    document: vscode.TextDocument,
    position: vscode.Position,
    isCurrent: () => boolean,
    explicit: boolean,
    record: RecordTiming
  ): Promise<Definition | undefined> {
    if (!isTrustedLocal() || !isCurrent()) return;
    const reference = this.reference(document, position);
    if (!reference) return;
    const { module, members } = reference;
    const project = await this.projectSource(document);
    if (!project || (module.startsWith('.') && !project.origin)) return;
    const { folder, anchor, origin, settings } = project;
    if (!origin && !settings?.defaultInterpreter) {
      if (explicit) throw new Error('Set a default SSH interpreter in RunHop Configurations.');
      return;
    }
    if (!origin && !explicit) {
      const localStart = performance.now();
      if (await localModuleExists(module, folder.uri.fsPath, anchor)) return;
      if (!isCurrent()) return;
      // The language server can resolve project source in other roots, for
      // example through a custom Python import path in a monorepo.
      const locations = await projectDefinitions(document, position);
      record('local definition', localStart);
      if (locations.length) return { locations };
    }
    if (!isCurrent()) return;
    const current = origin
      ? (await this.savedEndpoint(origin)).current
      : endpoint(folder, anchor, settings!, settings!.defaultInterpreter!);
    const connectionStart = performance.now();
    const query = {
      module,
      members,
      package:
        origin &&
        (origin.package ? origin.module : origin.module.split('.').slice(0, -1).join('.')),
    };
    const result = await this.connection(current, folder, async fs => {
      record('SSH/SFTP', connectionStart);
      if (!isCurrent()) return;
      const lookupStart = performance.now();
      return this.locator.locate(
        current.authority,
        fs.getClient().getRawClient(),
        current.interpreter.path,
        await this.script(),
        query,
        isCurrent,
        mode => record('remote locator (' + mode + ')', lookupStart)
      );
    });
    if (!isCurrent()) return;
    if (isRecord(result) && result.status === 'permission') {
      if (explicit) throw new Error(String(result.message));
      return;
    }
    if (isRecord(result) && result.status === 'error') {
      throw new Error(String(result.message || 'The remote Python source request failed.'));
    }
    if (!validLocation(result)) return;
    const file = {
      ...result,
      authority: current.authority,
      anchor,
      workspace: folder.uri.toString(),
      interpreter: current.name,
    };
    const uri = sourceUri(file);
    const key = this.key(uri);
    const stored = this.files.get(key);
    this.files.delete(key);
    this.files.set(key, file);
    while (this.files.size > 128) {
      const oldest = [...this.files.keys()].find(
        id => !vscode.workspace.textDocuments.some(document => this.key(document.uri) === id)
      );
      if (!oldest || oldest === key) break;
      this.files.delete(oldest);
      this.revisions.delete(oldest);
      this.diskReads.delete(oldest);
    }
    if (
      !stored ||
      stored.module !== file.module ||
      stored.package !== file.package ||
      stored.interpreter !== file.interpreter ||
      stored.anchor !== file.anchor
    ) {
      await this.context.workspaceState.update(storageKey, [...this.files.values()]);
    }
    return {
      uri,
      selection: new vscode.Range(result.line - 1, 0, result.line - 1, 0),
    };
  }

  private async access<T>(
    uri: vscode.Uri,
    work: (fs: RemoteFileSystem, python: string) => Promise<T>
  ): Promise<T> {
    if (!isTrustedLocal()) throw vscode.FileSystemError.NoPermissions(uri);
    const file = this.files.get(this.key(uri));
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    const { current, folder } = await this.savedEndpoint(file);
    return this.connection(current, folder, fs => work(fs, current.interpreter.path));
  }

  private async fileStat(fs: RemoteFileSystem, uri: vscode.Uri) {
    try {
      const info = await fs.lstat(uri.path);
      if (info.type !== FileType.File) {
        throw vscode.FileSystemError.NoPermissions(
          'The remote source is no longer a regular file.'
        );
      }
      if (info.size > maxBytes) {
        throw vscode.FileSystemError.Unavailable('The remote source exceeds 8 MiB.');
      }
      return info;
    } catch (error) {
      if (isNotFoundError(error)) throw vscode.FileSystemError.FileNotFound(uri);
      if (error.code === 3 || error.code === 'EACCES') {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      throw error;
    }
  }

  private directoryEntries(uri: vscode.Uri): [string, vscode.FileType][] {
    const directory = uri.path.endsWith('/') ? uri.path : uri.path + '/';
    const children = new Map<string, vscode.FileType>();
    for (const file of this.files.values()) {
      if (file.authority !== uri.authority || !file.path.startsWith(directory)) continue;
      const [name, next] = file.path.slice(directory.length).split('/');
      if (name) children.set(name, next ? vscode.FileType.Directory : vscode.FileType.File);
    }
    return [...children];
  }

  watch(): vscode.Disposable {
    // Each editor reads a single source file on demand. External edits are
    // checked by the save operation rather than polling remote environments.
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!this.files.has(this.key(uri)) && this.directoryEntries(uri).length) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const { atime, mtime, size, mode } = await this.access(uri, fs => this.fileStat(fs, uri));
    return {
      type: vscode.FileType.File,
      ctime: atime,
      mtime,
      size,
      ...(mode & 0o222 ? {} : { permissions: vscode.FilePermission.Readonly }),
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (!isTrustedLocal()) throw vscode.FileSystemError.NoPermissions(uri);
    const children = this.directoryEntries(uri);
    if (!children.length) throw vscode.FileSystemError.FileNotFound(uri);
    return children;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const content = await this.access(uri, async fs => {
      const readStart = performance.now();
      await this.fileStat(fs, uri);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of await fs.get(uri.path)) {
        size += chunk.length;
        if (size > maxBytes) {
          throw vscode.FileSystemError.Unavailable('The remote source exceeds 8 MiB.');
        }
        chunks.push(chunk);
      }
      this.log.appendLine(
        'RunHop source SFTP read: ' + Math.round(performance.now() - readStart) + ' ms'
      );
      return Buffer.concat(chunks, size);
    });
    const key = this.key(uri);
    const document = vscode.workspace.textDocuments.find(item => this.key(item.uri) === key);
    const disk = { bytes: digest(content), text: normalizedTextDigest(content.toString('utf8')) };
    this.diskReads.set(key, disk);
    if (!document) {
      this.revisions.set(key, disk.bytes);
    } else {
      this.refreshRevision(document);
    }
    return content;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const key = this.key(uri);
    if (!this.files.has(key)) throw vscode.FileSystemError.NoPermissions(uri);
    if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    if (content.byteLength > maxBytes) {
      throw vscode.FileSystemError.Unavailable('The remote source exceeds 8 MiB.');
    }
    const previous = this.writes.get(key);
    const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() =>
      this.save(uri, key, content)
    );
    this.writes.set(key, write);
    try {
      await write;
    } finally {
      if (this.writes.get(key) === write) this.writes.delete(key);
    }
  }

  private async save(uri: vscode.Uri, key: string, content: Uint8Array): Promise<void> {
    const originalDigest = this.revisions.get(key);
    if (!originalDigest) {
      throw vscode.FileSystemError.Unavailable('Reload the remote source before saving.');
    }
    await this.access(uri, (fs, python) =>
      this.saveTo(fs, python, uri, key, content, originalDigest)
    );
  }

  private async saveTo(
    fs: RemoteFileSystem,
    python: string,
    uri: vscode.Uri,
    key: string,
    content: Uint8Array,
    originalDigest: string
  ): Promise<void> {
    const { mode } = await this.fileStat(fs, uri);
    if (!(mode & 0o222)) throw vscode.FileSystemError.NoPermissions(uri);
    const temporary = path.posix.join(
      path.posix.dirname(uri.path),
      '.runhop-source-' + randomUUID()
    );
    const newDigest = digest(content);
    try {
      await fs.put(Readable.from([Buffer.from(content)]), temporary, { flags: 'wx', mode: 0o600 });
      const result = await inspectOnce(
        fs.getClient().getRawClient(),
        python,
        await this.script(),
        'replace',
        { path: uri.path, temporary, originalDigest, newDigest }
      );
      if (!isRecord(result) || result.status !== 'saved') {
        const message =
          isRecord(result) && typeof result.message === 'string'
            ? result.message
            : 'The remote source save failed.';
        if (isRecord(result) && result.status === 'permission') {
          throw vscode.FileSystemError.NoPermissions(message);
        }
        throw vscode.FileSystemError.Unavailable(message);
      }
      this.revisions.set(key, newDigest);
      this.diskReads.delete(key);
      this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

export function registerRemoteSources(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): void {
  const sources = new RemoteSources(context, log);
  const selector = [
    { language: 'python', scheme: 'file' },
    { language: 'python', scheme },
  ];
  let navigation = 0;
  let contextRevision = 0;
  const settings = vscode.workspace.createFileSystemWatcher('**/.vscode/runhop.json');
  const prepared = new Map<string, string>();
  const preparation = new Map<string, symbol>();
  const editorPaths = new Map<string, string>();
  const reported = new WeakSet<SourceConnectionError>();
  let disposed = false;

  function registerLinks(): vscode.Disposable {
    return vscode.languages.registerDocumentLinkProvider(selector, {
      async provideDocumentLinks(document, token) {
        try {
          return await sources.links(document, token);
        } catch (error) {
          if (!token.isCancellationRequested) {
            log.appendLine('RunHop source links: ' + error.message);
          }
        }
      },
    });
  }

  let links = registerLinks();

  function reportConnection(error: SourceConnectionError): void {
    if (reported.has(error)) return;
    reported.add(error);
    const detail =
      error.attempts > 1
        ? 'SSH connection failed after ' + error.attempts + ' attempts.\n\n' + error.message
        : error.message;
    log.appendLine('RunHop source SSH: ' + detail);
    void vscode.window
      .showErrorMessage(
        'RunHop could not connect to ' + error.host + '.',
        { modal: true, detail },
        'Show Output'
      )
      .then(action => {
        if (action === 'Show Output') log.show();
      });
  }

  async function prepare(folder: vscode.WorkspaceFolder): Promise<void> {
    if (disposed || !isTrustedLocal() || folder.uri.scheme !== 'file') return;
    const key = folder.uri.toString();
    const revision = Symbol();
    preparation.set(key, revision);
    const isCurrent = () => !disposed && preparation.get(key) === revision;
    const configured = vscode.workspace.getConfiguration(sourceSettings, folder.uri);
    let current: Endpoint | undefined;
    try {
      current = await sources.defaultEndpoint(folder, editorPaths.get(key) ?? folder.uri.fsPath);
    } catch {
      if (isCurrent()) prepared.delete(key);
      return;
    }
    if (!isCurrent()) return;
    if (current) updateSourceRemoteIdle(current.target.config, sourceIdleMs(folder));
    if (!current || !configured.get('preconnect', true)) {
      prepared.delete(key);
      return;
    }
    const identity = current.name + ':' + current.authority;
    if (prepared.get(key) === identity) return;
    prepared.set(key, identity);
    try {
      await sources.preconnect(current, folder);
    } catch (error) {
      if (disposed || prepared.get(key) !== identity) return;
      if (error instanceof SourceConnectionError) {
        reportConnection(error);
      } else if (!(error instanceof BackgroundAuthenticationRequired)) {
        log.appendLine('RunHop source preconnect: ' + error.message);
      }
    }
  }

  function refreshPreparation(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    if (folder && uri) editorPaths.set(folder.uri.toString(), uri.fsPath);
    const project = folder ?? (folders.length === 1 ? folders[0] : undefined);
    if (project) void prepare(project);
  }

  function configurationFileChanged(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.fsPath !== path.join(folder.uri.fsPath, settingsFile)) return;
    void updateContext();
    // Refresh links in Python files that were already open before a default was set.
    links.dispose();
    links = registerLinks();
    void prepare(folder);
  }

  async function updateContext(): Promise<void> {
    const revision = ++contextRevision;
    const editor = vscode.window.activeTextEditor;
    const enabled = editor ? await sources.enabled(editor.document).catch(() => false) : false;
    if (revision === contextRevision) {
      await vscode.commands.executeCommand('setContext', 'runhop.remoteSourceNavigation', enabled);
    }
  }

  async function open(
    document: vscode.TextDocument,
    position: vscode.Position,
    editor: vscode.TextEditor | undefined,
    mode: 'link' | 'keyboard' | 'explicit'
  ): Promise<void> {
    const request = ++navigation;
    const started = performance.now();
    const timings: string[] = [];
    const record: RecordTiming = (label, start) => {
      timings.push(label + ' ' + Math.round(performance.now() - start) + ' ms');
    };
    const version = document.version;
    const original = editor?.selections;
    const reference = sources.reference(document, position);
    let selected: vscode.Selection | undefined;
    if (mode === 'link' && editor && reference) {
      // The same click may also start another extension's definition query.
      // Selecting the clicked token cancels that pending editor action while
      // the explicit SSH link resolves.
      const start = document.positionAt(reference.from);
      const end = document.positionAt(reference.to);
      selected = editor.selection.active.isEqual(end)
        ? new vscode.Selection(end, start)
        : new vscode.Selection(start, end);
      editor.selection = selected;
    }
    function restore() {
      if (editor && original && selected && editor.selection.isEqual(selected)) {
        editor.selections = original;
      }
    }
    function isCurrent() {
      return (
        request === navigation &&
        document.version === version &&
        !document.isClosed &&
        (!selected || Boolean(editor?.selection.isEqual(selected)))
      );
    }
    try {
      const definition = reference
        ? await sources.definition(document, position, isCurrent, mode === 'explicit', record)
        : undefined;
      if (!isCurrent()) return;
      restore();
      if (definition && 'locations' in definition) {
        await vscode.commands.executeCommand(
          'editor.action.goToLocations',
          document.uri,
          position,
          definition.locations,
          vscode.workspace
            .getConfiguration('editor.gotoLocation', document)
            .get('multipleDefinitions')
        );
      } else if (definition) {
        const editorStart = performance.now();
        await vscode.window.showTextDocument(definition.uri, {
          selection: definition.selection,
          viewColumn: editor?.viewColumn,
          preview: false,
        });
        record('editor open', editorStart);
      } else if (mode === 'explicit') {
        void vscode.window.showInformationMessage(
          'RunHop: No Python source found for this imported symbol.'
        );
      } else if (vscode.window.activeTextEditor?.document === document) {
        if (mode === 'link' && editor) editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.revealDefinition');
      }
    } catch (error) {
      if (request === navigation) {
        restore();
        if (error instanceof SourceConnectionError) {
          reportConnection(error);
        } else if (error.code !== ErrorCode.CONNECT_CANCELLED) {
          void vscode.window.showErrorMessage('RunHop: ' + error.message);
        }
      }
    } finally {
      if (request === navigation) restore();
      if (timings.length) {
        record('total', started);
        log.appendLine('RunHop source navigation: ' + timings.join(' · '));
      }
    }
  }

  void updateContext();
  refreshPreparation();
  context.subscriptions.push(
    sources,
    new vscode.Disposable(() => {
      disposed = true;
      links.dispose();
      preparation.clear();
      prepared.clear();
    }),
    settings,
    settings.onDidCreate(configurationFileChanged),
    settings.onDidChange(configurationFileChanged),
    settings.onDidDelete(configurationFileChanged),
    vscode.workspace.onDidSaveTextDocument(document => configurationFileChanged(document.uri)),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void updateContext();
      refreshPreparation();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void updateContext();
      refreshPreparation();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(({ removed }) => {
      for (const { uri } of removed) {
        const key = uri.toString();
        editorPaths.delete(key);
        prepared.delete(key);
        preparation.delete(key);
      }
      refreshPreparation();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(sourceSettings)) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (
            prepared.has(folder.uri.toString()) &&
            event.affectsConfiguration(sourceSettings, folder.uri)
          ) {
            void prepare(folder);
          }
        }
        refreshPreparation();
      }
    }),
    vscode.workspace.onDidOpenTextDocument(document => sources.refreshRevision(document)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => sources.refreshRevision(document)),
    vscode.workspace.registerFileSystemProvider(scheme, sources, { isCaseSensitive: true }),
    vscode.commands.registerCommand(
      linkCommand,
      async (uri: unknown, version: unknown, offset: unknown) => {
        if (
          !isTrustedLocal() ||
          typeof uri !== 'string' ||
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        ) {
          return;
        }
        const document = vscode.workspace.textDocuments.find(
          item =>
            item.uri.toString() === uri && item.version === version && item.languageId === 'python'
        );
        if (!document) return;
        const position = document.positionAt(offset);
        if (sources.reference(document, position)?.from !== offset) return;
        const editor = vscode.window.visibleTextEditors.find(item => item.document === document);
        await open(document, position, editor, 'link');
      }
    ),
    vscode.commands.registerCommand('runhop.goToDefinition', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId === 'python') {
        await open(editor.document, editor.selection.active, editor, 'keyboard');
      }
    }),
    vscode.commands.registerCommand('runhop.remoteDefinition', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') return;
      if (!isTrustedLocal()) {
        void vscode.window.showErrorMessage('RunHop: Open a trusted local project.');
        return;
      }
      await open(editor.document, editor.selection.active, editor, 'explicit');
    })
  );
}
