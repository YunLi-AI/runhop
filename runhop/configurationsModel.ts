import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { formatArguments, parseArguments } from './arguments';
import { ConfigurationInputError } from './configurationLocale';
import { artifactPath, isLocalPathAtOrUnder } from './paths';
import {
  Connection,
  Interpreter,
  ScriptOptions,
  SettingEdit,
  Settings,
  scriptLaunchOptions,
  interpreterFor,
  isPythonModule,
  isRecord,
  isSyncMode,
  scriptKey,
} from './settings';
import { matchingTargets, resolveProjectTarget, resolveTarget } from './targets';

export const sections = ['run', 'servers', 'interpreters', 'sync'] as const;
export type ConfigurationSection = (typeof sections)[number];
export interface ConfigurationFocus {
  section: ConfigurationSection;
  key?: string;
  field?: string;
  create?: boolean;
}

interface EnvironmentRow {
  name: string;
  original?: string;
  value?: string;
}

export interface ConfigurationRow {
  key: string;
  label: string;
  detail?: string;
  values: Record<string, string | boolean | EnvironmentRow[]>;
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const lines = (value: unknown) =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
const syncRows = (value: unknown) => (isSyncMode(value) ? value : '');
const interpolatableEnvName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function scriptValues(script: unknown, active: boolean) {
  const raw = isRecord(script) ? script : {};
  return {
    name: '',
    kind: raw.module === undefined ? 'script' : 'module',
    program: text(raw.program),
    module: text(raw.module),
    runOn: text(raw.runOn),
    interpreter: text(raw.interpreter),
    localPython: text(raw.localPython),
    cwd: text(raw.cwd),
    args: formatArguments(
      Array.isArray(raw.args) ? raw.args.filter(v => typeof v === 'string') : []
    ),
    env: isRecord(raw.env) ? Object.keys(raw.env).map(name => ({ name, original: name })) : [],
    download: lines(raw.download),
    syncMode: syncRows(raw.syncMode),
    justMyCode: raw.justMyCode !== false,
    stopOnEntry: raw.stopOnEntry === true,
    active,
  };
}

function targetValues(raw: Connection) {
  const auth = text(
    raw.authentication,
    raw.privateKeyPath ? 'key' : raw.agent ? 'agent' : raw.password ? 'password' : 'sshConfig'
  );
  return {
    name: text(raw.name),
    host: text(raw.host),
    port: typeof raw.port === 'number' ? String(raw.port) : text(raw.port),
    username: text(raw.username),
    auth,
    sshConfigPath: text(raw.sshConfigPath),
    privateKeyPath: text(raw.privateKeyPath),
    agent: text(raw.agent),
    encryptedKey: raw.passphrase === true || typeof raw.passphrase === 'string',
    context: text(raw.context, '.'),
    remotePath: text(raw.remotePath, '.'),
    ignore: lines(raw.ignore),
    ignoreFile: text(raw.ignoreFile),
    defaultProfile: text(raw.defaultProfile),
  };
}

export function configurationRows(
  settings: Settings,
  currentScript?: string
): Record<ConfigurationSection, ConfigurationRow[]> {
  return {
    run: [
      ...(currentScript
        ? [
            {
              key: 'file',
              label: 'Current Python File',
              detail: currentScript,
              values: scriptValues(
                Object.hasOwn(settings.scripts ?? {}, currentScript)
                  ? settings.scripts?.[currentScript]
                  : undefined,
                !settings.activeRunConfiguration
              ),
            },
          ]
        : [
            {
              key: 'current',
              label: 'Current Python File',
              values: { active: !settings.activeRunConfiguration },
            },
          ]),
      ...Object.entries(settings.runConfigurations ?? {}).map(([name, config]) => ({
        key: 'run:' + name,
        label: name,
        detail: text(config?.program ?? config?.module),
        values: { ...scriptValues(config, name === settings.activeRunConfiguration), name },
      })),
    ],
    servers: settings.targets.map((target, index) => ({
      key: 'server:' + index,
      label: text(target.name) || text(target.host) || 'SSH server ' + (index + 1),
      detail: text(target.host),
      values: targetValues(target),
    })),
    interpreters: Object.entries(settings.interpreters ?? {}).map(([name, entry]) => {
      const interpreter: Record<string, unknown> = isRecord(entry) ? entry : {};
      return {
        key: 'python:' + name,
        label: name,
        detail: text(interpreter.target) || text(interpreter.path),
        values: {
          name,
          path: text(interpreter.path),
          target: text(interpreter.target),
          profile: text(interpreter.profile),
          condaExecutable: text(interpreter.condaExecutable),
          default: name === settings.defaultInterpreter,
        },
      };
    }),
    sync: [
      {
        key: 'project',
        label: 'Project defaults',
        values: {
          syncMode: settings.syncMode ?? 'incremental',
          uploadOnSave: settings.uploadOnSave !== false,
        },
      },
      ...settings.targets.map((target, index) => ({
        key: 'server:' + index,
        label: text(target.name) || text(target.host) || 'SSH server ' + (index + 1),
        detail: text(target.remotePath, '.'),
        values: targetValues(target),
      })),
    ],
  };
}

export function targetProfiles(settings: Settings) {
  return settings.targets.map(({ profiles, defaultProfile }) => ({
    names: isRecord(profiles) ? Object.keys(profiles) : [],
    defaultProfile: text(defaultProfile),
  }));
}

export function requireFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid configuration fields.');
  return value;
}

function field(fields: Record<string, unknown>, name: string, fallback = ''): string {
  const value = Object.hasOwn(fields, name) ? fields[name] : fallback;
  if (typeof value !== 'string' || value.length > 65_536 || value.includes('\0')) {
    throw new ConfigurationInputError('Invalid {0}.', name);
  }
  return value;
}

function flag(fields: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = Object.hasOwn(fields, name) ? fields[name] : fallback;
  if (typeof value !== 'boolean') throw new ConfigurationInputError('Invalid {0}.', name);
  return value;
}

function named(value: string, label: string): string {
  const name = value.trim();
  if (!name || name.length > 200 || /[\r\n]/.test(name) || name === '__proto__') {
    throw new Error('Enter a valid ' + label + ' name.');
  }
  return name;
}

function pathField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = field(fields, name).trim();
  if (/[\r\n]/.test(value)) throw new ConfigurationInputError('Enter a single path for {0}.', name);
  return value || undefined;
}

function recordEntry(object: Record<string, unknown> | undefined, name: string) {
  if (!object || !Object.hasOwn(object, name)) throw new Error('This entry no longer exists.');
  const entry = object[name];
  return isRecord(entry) ? entry : {};
}

function serverIndex(settings: Settings, key: string): number {
  if (!/^server:\d+$/.test(key)) throw new Error('Select an SSH server.');
  const index = Number(key.slice('server:'.length));
  if (!settings.targets[index]) throw new Error('This SSH server no longer exists.');
  return index;
}

function patchEntry(
  at: SettingEdit['at'],
  original: Record<string, unknown>,
  values: Record<string, unknown>
): SettingEdit[] {
  return Object.entries(values)
    .filter(([key, value]) => JSON.stringify(original[key]) !== JSON.stringify(value))
    .map(([key, value]) => ({ at: [...at, key], value }));
}

function namedEntry(
  section: 'interpreters' | 'runConfigurations',
  oldName: string | undefined,
  name: string,
  original: Record<string, unknown>,
  values: Record<string, unknown>
): SettingEdit[] {
  if (name === oldName) return patchEntry([section, name], original, values);
  return [
    { at: [section, name], value: { ...original, ...values } },
    ...(oldName === undefined ? [] : [{ at: [section, oldName], value: undefined }]),
  ];
}

function checkName(
  names: Record<string, unknown> | undefined,
  previous: string | undefined,
  name: string
): void {
  if (name !== previous && Object.hasOwn(names ?? {}, name)) {
    throw new ConfigurationInputError('An entry already uses the name {0}.', name);
  }
}

async function localPath(workspace: string, input: string, kind: 'file' | 'directory') {
  const file = path.resolve(workspace, input);
  const actual = await realpath(file).catch(() => undefined);
  if (
    !actual ||
    !isLocalPathAtOrUnder(workspace, file) ||
    !isLocalPathAtOrUnder(await realpath(workspace), actual)
  ) {
    throw new Error('Choose an existing ' + kind + ' inside the workspace.');
  }
  const info = await stat(actual);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    const message = kind === 'file' ? 'Expected a file at {0}.' : 'Expected a directory at {0}.';
    throw new ConfigurationInputError(message, input);
  }
  return file;
}

function environment(fields: Record<string, unknown>, existing: unknown) {
  const rows = fields.env;
  if (!Array.isArray(rows) || rows.length > 512) throw new Error('Invalid environment variables.');
  const saved = isRecord(existing) ? existing : {};
  const names = new Set<string>();
  return Object.fromEntries(
    rows.map(entry => {
      const row = requireFields(entry);
      const name = field(row, 'name').trim();
      if (!interpolatableEnvName.test(name) || name === '__proto__' || names.has(name)) {
        throw new Error('Enter a unique environment variable name.');
      }
      names.add(name);
      let value = field(row, 'value');
      if (!Object.hasOwn(row, 'value') && row.original !== undefined) {
        const original = field(row, 'original');
        if (!Object.hasOwn(saved, original) || typeof saved[original] !== 'string') {
          throw new Error('The saved environment value is unavailable.');
        }
        value = saved[original];
      }
      return [name, value];
    })
  );
}

function interpreterReferences(settings: Settings, name: string): SettingEdit['at'][] {
  return (['runConfigurations', 'scripts'] as const).flatMap(section =>
    Object.entries(settings[section] ?? {}).flatMap(([key, entry]) =>
      entry?.interpreter === name ? [[section, key, 'interpreter']] : []
    )
  );
}

function syncMode(value: string, optional = false) {
  if (optional && !value) return undefined;
  if (!isSyncMode(value)) throw new Error('Choose a valid synchronization mode.');
  return value;
}

export function makeServer(
  settings: Settings,
  key: string,
  fields: Record<string, unknown>,
  syncOnly = false
): { raw: Connection; index?: number; values: Connection } {
  const index = key === 'new' && !syncOnly ? undefined : serverIndex(settings, key);
  const previous = index === undefined ? {} : settings.targets[index];
  const context = pathField(fields, 'context') ?? '.';
  const remotePath = pathField(fields, 'remotePath');
  if (!remotePath) throw new Error('Enter the remote project root.');
  const values: Connection = { context, remotePath };
  if (syncOnly) {
    values.ignore = field(fields, 'ignore').split(/\r?\n/).filter(Boolean);
    values.ignoreFile = pathField(fields, 'ignoreFile');
  } else {
    const name = named(field(fields, 'name'), 'SSH server');
    const host = field(fields, 'host').trim();
    const username = pathField(fields, 'username');
    const portInput = field(fields, 'port').trim();
    const port = portInput ? Number(portInput) : undefined;
    const auth = field(fields, 'auth', 'sshConfig');
    if (!/^[a-zA-Z0-9._:][a-zA-Z0-9._:%-]*$/.test(host)) {
      throw new Error('Enter a hostname, IP address or OpenSSH alias.');
    }
    if (username && /\s/.test(username)) throw new Error('Enter a valid SSH username.');
    if (port !== undefined && (!/^\d+$/.test(portInput) || port < 1 || port > 65535)) {
      throw new Error('Port must be between 1 and 65535.');
    }
    if (!['sshConfig', 'key', 'agent', 'password'].includes(auth)) {
      throw new Error('Choose an SSH authentication method.');
    }
    const identity = auth === 'key' ? pathField(fields, 'privateKeyPath') : undefined;
    const agent = auth === 'agent' ? (pathField(fields, 'agent') ?? '$SSH_AUTH_SOCK') : undefined;
    const usePassphrase = flag(fields, 'encryptedKey');
    if (auth === 'key' && !identity) throw new Error('Choose an SSH identity file.');
    if (settings.targets.some((target, i) => i !== index && target.name === name)) {
      throw new ConfigurationInputError('An SSH server already uses the name {0}.', name);
    }
    const defaultProfile = pathField(fields, 'defaultProfile');
    if (
      defaultProfile &&
      !(isRecord(previous.profiles) && Object.hasOwn(previous.profiles, defaultProfile))
    ) {
      throw new Error('Select an existing SSH profile.');
    }
    Object.assign(values, {
      defaultProfile,
      name,
      host,
      username,
      port,
      authentication: auth,
      sshConfigPath: pathField(fields, 'sshConfigPath'),
      privateKeyPath: identity,
      agent,
      passphrase:
        identity && usePassphrase
          ? (identity === previous.privateKeyPath ? previous.passphrase : undefined) || true
          : undefined,
      password:
        auth === 'password' || auth === targetValues(previous).auth ? previous.password : undefined,
    });
  }
  return { raw: { ...previous, ...values }, index, values };
}

export function makeInterpreter(settings: Settings, fields: Record<string, unknown>): Interpreter {
  const entry = {
    path: field(fields, 'path').trim(),
    target: field(fields, 'target') || undefined,
    profile: field(fields, 'profile') || undefined,
    condaExecutable: pathField(fields, 'condaExecutable'),
  };
  const target = entry.target && settings.targets.find(server => server.name === entry.target);
  if (entry.target && !target) throw new Error('Select an existing SSH server.');
  if (
    entry.profile &&
    target &&
    !(isRecord(target.profiles) && Object.hasOwn(target.profiles, entry.profile))
  ) {
    throw new Error('Select an existing SSH profile.');
  }
  return interpreterFor({ ...settings, interpreters: { draft: entry } }, 'draft')!;
}

export interface ConfigurationChange {
  section: ConfigurationSection;
  key: string;
  fields: Record<string, unknown>;
  copyFrom?: string;
  remove?: boolean;
}

export async function configurationEdits(
  settings: Settings,
  workspace: string,
  currentScript: string | undefined,
  change: ConfigurationChange
): Promise<{ edits: SettingEdit[]; key?: string }> {
  const { section, key, fields, copyFrom, remove } = change;
  if (section === 'run') {
    const file = key === 'file' && currentScript;
    const current = key === 'current';
    const existing = key.startsWith('run:') ? key.slice(4) : undefined;
    if (current) {
      return { edits: [{ at: ['activeRunConfiguration'], value: undefined }], key };
    }
    if (!file && existing === undefined && key !== 'new') {
      throw new Error('Select a run configuration.');
    }
    const at: SettingEdit['at'] = file ? ['scripts', file] : ['runConfigurations', existing ?? ''];
    if (remove && existing !== undefined) {
      recordEntry(settings.runConfigurations, existing);
      return {
        edits: [
          { at, value: undefined },
          ...(existing === settings.activeRunConfiguration
            ? [{ at: ['activeRunConfiguration'], value: undefined }]
            : []),
        ],
      };
    }
    const original = file
      ? (settings.scripts?.[file] ?? {})
      : existing !== undefined
        ? recordEntry(settings.runConfigurations, existing)
        : copyFrom !== undefined
          ? recordEntry(settings.runConfigurations, copyFrom)
          : {};
    const name = file ? undefined : named(field(fields, 'name'), 'run configuration');
    if (name !== undefined) checkName(settings.runConfigurations, existing, name);
    const kind = file ? 'script' : field(fields, 'kind');
    const module = kind === 'module' ? field(fields, 'module').trim() : undefined;
    const script = file || (kind === 'script' && pathField(fields, 'program'));
    if (kind === 'module' ? !isPythonModule(module) : !script) {
      throw new Error('Enter an existing script path or a dotted Python module name.');
    }
    const program = script ? await localPath(workspace, script, 'file') : undefined;
    const cwdInput = pathField(fields, 'cwd');
    const cwd = cwdInput ? await localPath(workspace, cwdInput, 'directory') : undefined;
    const interpreter = field(fields, 'interpreter') || undefined;
    const runOn = field(fields, 'runOn');
    if (runOn && runOn !== 'local' && runOn !== 'remote') throw new Error('Choose a run location.');
    const values = {
      runOn: runOn || undefined,
      interpreter,
      localPython: pathField(fields, 'localPython'),
      cwd: cwd ? scriptKey(workspace, cwd) || '.' : undefined,
      args: parseArguments(field(fields, 'args')),
      env: environment(fields, 'env' in original ? original.env : undefined),
      download: field(fields, 'download').split(/\r?\n/).filter(Boolean).map(artifactPath),
      syncMode: syncMode(field(fields, 'syncMode'), true),
      justMyCode: flag(fields, 'justMyCode', true),
      stopOnEntry: flag(fields, 'stopOnEntry'),
    };
    const next = {
      ...original,
      ...values,
      program: program && scriptKey(workspace, program),
      module,
    };
    const candidate = file
      ? { ...settings, scripts: { ...settings.scripts, [file]: next as ScriptOptions } }
      : ({
          ...settings,
          runConfigurations: { ...settings.runConfigurations, [name!]: next },
        } as Settings);
    const selection = scriptLaunchOptions(candidate, workspace, program, name);
    const anchor = program ?? cwd ?? workspace;
    if (
      selection.options.runOn !== 'local' &&
      (selection.options.runOn === 'remote' ||
        selection.options.interpreter ||
        matchingTargets(settings.targets, workspace, anchor).length > 0)
    ) {
      const selectedInterpreter = interpreterFor(
        settings,
        selection.options.interpreter ?? settings.defaultInterpreter
      );
      const target = resolveTarget(
        settings.targets,
        workspace,
        anchor,
        selectedInterpreter?.target,
        selectedInterpreter?.profile
      );
      const root = await localPath(workspace, target.service.baseDir, 'directory');
      for (const location of [program, cwd]) {
        if (
          location &&
          (!isLocalPathAtOrUnder(root, location) ||
            !isLocalPathAtOrUnder(await realpath(root), await realpath(location)))
        ) {
          throw new Error(
            'The script and working directory must be within the SSH project mapping.'
          );
        }
      }
    }
    const edits =
      name === undefined
        ? patchEntry(at, { ...original }, values)
        : namedEntry('runConfigurations', existing, name, { ...original }, next);
    if (
      flag(fields, 'active') ||
      (existing !== undefined && existing === settings.activeRunConfiguration)
    ) {
      edits.push({
        at: ['activeRunConfiguration'],
        value: flag(fields, 'active') ? name : undefined,
      });
    }
    return { edits, key: name === undefined ? 'file' : 'run:' + name };
  }
  if (section === 'interpreters') {
    if (key !== 'new' && !key.startsWith('python:')) {
      throw new Error('Select a remote interpreter.');
    }
    const existing = key === 'new' ? undefined : key.slice(7);
    const original = existing === undefined ? {} : recordEntry(settings.interpreters, existing);
    const references = existing === undefined ? [] : interpreterReferences(settings, existing);
    if (remove && existing !== undefined) {
      if (references.length) {
        throw new ConfigurationInputError(
          'Change the interpreter in {0} before removing it.',
          references[0][1]
        );
      }
      return {
        edits: [
          { at: ['interpreters', existing], value: undefined },
          ...(settings.defaultInterpreter === existing
            ? [{ at: ['defaultInterpreter'], value: undefined }]
            : []),
        ],
      };
    }
    const name = named(field(fields, 'name'), 'interpreter');
    checkName(settings.interpreters, existing, name);
    const entry = makeInterpreter(settings, fields);
    const edits = namedEntry('interpreters', existing, name, original, { ...entry });
    if (existing !== name) edits.push(...references.map(at => ({ at, value: name })));
    if (
      flag(fields, 'default') ||
      (existing !== undefined && existing === settings.defaultInterpreter)
    ) {
      edits.push({ at: ['defaultInterpreter'], value: flag(fields, 'default') ? name : undefined });
    }
    return { edits, key: 'python:' + name };
  }
  if (section === 'sync' && key === 'project') {
    return {
      key,
      edits: [
        { at: ['syncMode'], value: syncMode(field(fields, 'syncMode')) },
        { at: ['uploadOnSave'], value: flag(fields, 'uploadOnSave', true) },
      ],
    };
  }

  if (remove && section === 'servers') {
    const index = serverIndex(settings, key);
    const name = settings.targets[index].name;
    if (name && Object.values(settings.interpreters ?? {}).some(entry => entry?.target === name)) {
      throw new Error('Move or remove the interpreters linked to this SSH server first.');
    }
    return { edits: [{ at: ['targets', index], value: undefined }] };
  }
  const { raw, index, values } = makeServer(settings, key, fields, section === 'sync');
  const baseDir = await localPath(workspace, text(raw.context, '.'), 'directory');
  resolveProjectTarget(workspace, { raw, baseDir });
  const edits =
    index === undefined
      ? [{ at: ['targets', -1], value: raw }]
      : patchEntry(['targets', index], settings.targets[index], values);
  const oldName = index === undefined ? undefined : settings.targets[index].name;
  if (oldName && oldName !== raw.name) {
    for (const [name, entry] of Object.entries(settings.interpreters ?? {})) {
      if (entry?.target === oldName) {
        edits.push({ at: ['interpreters', name, 'target'], value: raw.name });
      }
    }
  }
  return { edits, key: 'server:' + (index ?? settings.targets.length) };
}
