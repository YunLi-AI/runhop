import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import { applyEdits, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import * as vscode from 'vscode';

export const settingsFile = path.join('.vscode', 'runhop.json');

export type Connection = Record<string, unknown>;

export interface Interpreter {
  path: string;
  target?: string;
  profile?: string;
  condaExecutable?: string;
}

export interface ScriptOptions {
  runOn?: 'local' | 'remote';
  interpreter?: string;
  localPython?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  proxy?: string;
  download?: string[];
  justMyCode?: boolean;
  stopOnEntry?: boolean;
  uploadPolicy?: UploadPolicy;
  syncMode?: SyncMode;
  syncPolicy?: SyncPolicy;
}

export type RunConfiguration = ScriptOptions &
  ({ program: string; module?: never } | { program?: never; module: string });

export interface Settings {
  targets: Connection[];
  interpreters?: Record<string, Interpreter>;
  defaultInterpreter?: string;
  syncMode?: SyncMode;
  uploadOnSave?: boolean;
  deleteRemoteOnUpload?: boolean;
  scripts?: Record<string, ScriptOptions>;
  runConfigurations?: Record<string, RunConfiguration>;
  activeRunConfiguration?: string;
  uploadPolicy?: UploadPolicy;
  syncPolicy?: SyncPolicy;
  proxy?: string;
}

export type SyncMode = 'incremental' | 'full' | 'off';
export type UploadPolicy = 'safe' | 'force_upload' | 'force_download' | 'interactive';
export type SyncPolicy = UploadPolicy;

export function isSyncMode(value: unknown): value is SyncMode {
  return value === 'incremental' || value === 'full' || value === 'off';
}

export function isUploadPolicy(value: unknown): value is UploadPolicy {
  return (
    value === 'safe' ||
    value === 'force_upload' ||
    value === 'force_download' ||
    value === 'interactive'
  );
}

export function isSyncPolicy(value: unknown): value is SyncPolicy {
  return isUploadPolicy(value);
}

export function isProxy(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !/[\0\r\n]/.test(value);
}

export function proxyEnvironment(proxy: unknown): Record<string, string> {
  if (!isProxy(proxy)) return {};
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
  };
}

export function launchSyncMode(settings: Settings, override?: SyncMode): SyncMode {
  return override ?? settings.syncMode ?? 'incremental';
}

export function uploadPolicyFor(
  settings: Settings,
  override?: UploadPolicy,
  legacyOverride?: SyncPolicy
): UploadPolicy {
  return override ?? legacyOverride ?? settings.uploadPolicy ?? settings.syncPolicy ?? 'safe';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseJson(text: string, file: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error('Invalid ' + file + ': ' + printParseErrorCode(errors[0].error));
  }
  return parsed;
}

export function parseSettings(text: string): Settings {
  const raw = parseJson(text, settingsFile);
  if (
    !isRecord(raw) ||
    (raw.targets !== undefined && (!Array.isArray(raw.targets) || !raw.targets.every(isRecord)))
  ) {
    throw new Error(
      settingsFile + ' must contain a project object with an optional targets array.'
    );
  }
  if (raw.syncBeforeLaunch !== undefined || raw.incrementalSyncBeforeLaunch !== undefined) {
    throw new Error('Set syncMode to "incremental", "full" or "off" in ' + settingsFile + '.');
  }
  if (raw.syncMode !== undefined && !isSyncMode(raw.syncMode)) {
    throw new Error('syncMode must be "incremental", "full" or "off" in ' + settingsFile + '.');
  }
  if (raw.syncPolicy !== undefined && !isSyncPolicy(raw.syncPolicy)) {
    throw new Error(
      'syncPolicy must be "safe", "force_upload", "force_download" or "interactive" in ' +
        settingsFile +
        '.'
    );
  }
  if (raw.uploadPolicy !== undefined && !isUploadPolicy(raw.uploadPolicy)) {
    throw new Error(
      'uploadPolicy must be "safe", "force_upload", "force_download" or "interactive" in ' +
        settingsFile +
        '.'
    );
  }
  if (raw.proxy !== undefined && !isProxy(raw.proxy)) {
    throw new Error('proxy must be a non-empty proxy URL in ' + settingsFile + '.');
  }
  if (raw.uploadOnSave !== undefined && typeof raw.uploadOnSave !== 'boolean') {
    throw new Error('uploadOnSave must be true or false in ' + settingsFile + '.');
  }
  if (raw.deleteRemoteOnUpload !== undefined && typeof raw.deleteRemoteOnUpload !== 'boolean') {
    throw new Error('deleteRemoteOnUpload must be true or false in ' + settingsFile + '.');
  }
  if (
    (raw.interpreters !== undefined && !isRecord(raw.interpreters)) ||
    (raw.defaultInterpreter !== undefined && typeof raw.defaultInterpreter !== 'string') ||
    (raw.scripts !== undefined && !isRecord(raw.scripts)) ||
    (raw.runConfigurations !== undefined && !isRecord(raw.runConfigurations)) ||
    (raw.activeRunConfiguration !== undefined && typeof raw.activeRunConfiguration !== 'string')
  ) {
    throw new Error(
      'Invalid interpreter, script or run configuration settings in ' + settingsFile + '.'
    );
  }
  return { targets: [], ...raw } as Settings;
}

export async function readSettings(workspace: string): Promise<Settings> {
  return parseSettings(await readSettingsText(workspace));
}

export async function readOptionalSettings(workspace: string): Promise<Settings | undefined> {
  try {
    return await readSettings(workspace);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function readSettingsText(workspace: string): Promise<string> {
  const file = path.join(workspace, settingsFile);
  const document = vscode.workspace.textDocuments.find(
    doc => doc.uri.fsPath === file && doc.isDirty
  );
  if (document) {
    throw new Error('Save ' + settingsFile + ' before using RunHop.');
  }
  return readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('Run RunHop: Configurations to create ' + settingsFile + '.'), {
        code: 'ENOENT',
      });
    }
    throw error;
  });
}

export function scriptKey(workspace: string, program: string): string {
  return path.relative(workspace, program).split(path.sep).join('/');
}

function validRunLocation(value: unknown): boolean {
  return value === undefined || value === 'local' || value === 'remote';
}

function validLocalPython(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && Boolean(value.trim()) && !/[\0\r\n]/.test(value))
  );
}

export function optionsFor(settings: Settings, key: string): ScriptOptions {
  const options =
    settings.scripts && Object.hasOwn(settings.scripts, key) ? settings.scripts[key] : {};
  if (
    !isRecord(options) ||
    !validRunLocation(options.runOn) ||
    !validLocalPython(options.localPython) ||
    (options.interpreter !== undefined && typeof options.interpreter !== 'string') ||
    (options.proxy !== undefined && !isProxy(options.proxy)) ||
    (options.uploadPolicy !== undefined && !isUploadPolicy(options.uploadPolicy)) ||
    options.syncBeforeLaunch !== undefined ||
    (options.syncMode !== undefined && !isSyncMode(options.syncMode)) ||
    (options.syncPolicy !== undefined && !isSyncPolicy(options.syncPolicy))
  ) {
    throw new Error('Invalid RunHop script settings for ' + key + '.');
  }
  return options;
}

export function runConfigurationFor(settings: Settings, name: string): RunConfiguration {
  if (!settings.runConfigurations || !Object.hasOwn(settings.runConfigurations, name)) {
    throw new Error(
      'No RunHop run configuration named ' + name + '. Select a configuration to run.'
    );
  }
  const config = settings.runConfigurations[name];
  const validEntry =
    config?.program === undefined
      ? isPythonModule(config?.module)
      : typeof config.program === 'string' &&
        Boolean(config.program.trim()) &&
        !config.program.includes('\0') &&
        config.module === undefined;
  if (
    !isRecord(config) ||
    !validEntry ||
    !validRunLocation(config.runOn) ||
    !validLocalPython(config.localPython) ||
    (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.includes('\0'))) ||
    (config.interpreter !== undefined && typeof config.interpreter !== 'string') ||
    (config.proxy !== undefined && !isProxy(config.proxy)) ||
    (config.uploadPolicy !== undefined && !isUploadPolicy(config.uploadPolicy)) ||
    config.syncBeforeLaunch !== undefined ||
    (config.syncMode !== undefined && !isSyncMode(config.syncMode)) ||
    (config.syncPolicy !== undefined && !isSyncPolicy(config.syncPolicy))
  ) {
    throw new Error(
      'Invalid RunHop run configuration ' +
        name +
        '. Check its script or module, runOn, interpreter, localPython, cwd, syncMode and syncPolicy.'
    );
  }
  return config;
}

export function isPythonModule(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(value);
}

export function validateLaunchArguments(args: unknown, env: unknown): void {
  if (
    args !== undefined &&
    (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
  ) {
    throw new Error('args must be a list of strings without NUL characters.');
  }
  if (
    env !== undefined &&
    (!isRecord(env) ||
      Object.entries(env).some(
        ([name, value]) =>
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
          typeof value !== 'string' ||
          value.includes('\0')
      ))
  ) {
    throw new Error('env must map environment variable names to string values.');
  }
}

export function scriptLaunchOptions(
  settings: Settings,
  workspace: string,
  file?: string,
  name?: string
): { program?: string; module?: string; options: ScriptOptions } {
  const saved = name === undefined ? undefined : runConfigurationFor(settings, name);
  const program = saved ? saved.program && path.resolve(workspace, saved.program) : file;
  const source = program ? optionsFor(settings, scriptKey(workspace, program)) : {};
  const options = saved ? { ...source, ...saved } : source;
  return { program, options, ...(saved?.module ? { module: saved.module } : {}) };
}

export function configuredScript(
  settings: Settings,
  workspace: string,
  file?: string,
  name?: string
): { program?: string; module?: string; options: ScriptOptions; interpreter?: Interpreter } {
  const selection = scriptLaunchOptions(settings, workspace, file, name);
  return {
    ...selection,
    interpreter:
      selection.options.runOn === 'local'
        ? undefined
        : interpreterFor(settings, selection.options.interpreter ?? settings.defaultInterpreter),
  };
}

export function isRemotePython(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    (path.posix.isAbsolute(value) || /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(value))
  );
}

export function interpreterFor(settings: Settings, name?: string): Interpreter | undefined {
  if (!name) {
    return undefined;
  }
  if (!settings.interpreters || !Object.hasOwn(settings.interpreters, name)) {
    throw new Error('No RunHop remote interpreter named ' + name + '.');
  }
  const entry = settings.interpreters[name];
  if (
    !isRecord(entry) ||
    !isRemotePython(entry.path) ||
    (entry.condaExecutable !== undefined &&
      (typeof entry.condaExecutable !== 'string' ||
        !path.posix.isAbsolute(entry.condaExecutable) ||
        entry.condaExecutable.includes('\0'))) ||
    (entry.target !== undefined && typeof entry.target !== 'string') ||
    (entry.profile !== undefined && typeof entry.profile !== 'string')
  ) {
    throw new Error('Invalid RunHop remote interpreter ' + name + '.');
  }
  return entry;
}

export type SettingEdit = { at: (string | number)[]; value: unknown };

const pendingEdits = new Map<string, Promise<void>>();

export function applySettingsEdits(original: string, edits: SettingEdit[], eol = '\n'): string {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
  return edits.reduce(
    (text, edit) => applyEdits(text, modify(text, edit.at, edit.value, { formattingOptions })),
    original
  );
}

export function updateSettings(
  folder: vscode.WorkspaceFolder,
  changes: (settings: Settings) => SettingEdit[],
  expected?: string | null
): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'runhop.json');
  const key = uri.toString();
  const next = (pendingEdits.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeSettings(uri, changes, expected))
    .finally(() => {
      if (pendingEdits.get(key) === next) pendingEdits.delete(key);
    });
  pendingEdits.set(key, next);
  return next;
}

async function writeSettings(
  uri: vscode.Uri,
  changes: (settings: Settings) => SettingEdit[],
  expected?: string | null
): Promise<void> {
  const conflict = () => new Error('runhop.json changed. Reload before applying your changes.');
  const missing =
    expected === null ||
    (expected === undefined &&
      (await stat(uri.fsPath).then(
        () => false,
        error => {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      )));
  if (missing) {
    const original = '{}\n';
    const text = applySettingsEdits(original, changes(parseSettings(original)));
    if (text === original) return;
    await mkdir(path.dirname(uri.fsPath), { recursive: true });
    await writeFile(uri.fsPath, text, { flag: 'wx' }).catch(error => {
      if (error.code === 'EEXIST') throw conflict();
      throw error;
    });
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) {
    throw new Error('Save ' + settingsFile + ' before editing it through RunHop.');
  }
  const original = document.getText();
  if (expected !== undefined && expected !== original) throw conflict();
  const settings = parseSettings(original);
  const edits = changes(settings);
  if (!edits.length) {
    return;
  }
  const text = applySettingsEdits(
    original,
    edits,
    document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
  );
  if (text !== original) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(0), document.positionAt(original.length)),
      text
    );
    if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
      throw new Error('Could not save ' + settingsFile + '.');
    }
  }
}
