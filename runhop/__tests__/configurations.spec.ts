import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ConfigurationChange, configurationEdits, configurationRows } from '../configurationsModel';
import { fileRunsRemotely } from '../fileLaunch';
import { applySettingsEdits, configuredScript, parseSettings } from '../settings';
import { resolveTarget } from '../targets';
import { mapProjectPath } from '../paths';

let workspace: string;
let sshConfigPath: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'runhop-config-test-'));
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src', 'train.py'), '');
  sshConfigPath = path.join(workspace, 'ssh_config');
  await writeFile(
    sshConfigPath,
    'Host config-test-alias\n  HostName example.test\n  User tester\n  IdentityFile /example/id_ed25519\n'
  );
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function save(text: string, change: ConfigurationChange, script = 'src/train.py') {
  const { edits, key } = await configurationEdits(parseSettings(text), workspace, script, change);
  const result = applySettingsEdits(text, edits);
  return { settings: parseSettings(result), text: result, key };
}

function preset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Train',
    kind: 'script',
    program: 'src/train.py',
    args: '--label "one two"',
    env: [],
    active: true,
    ...overrides,
  };
}

test('creates and selects a named preset that the launch resolver reads', async () => {
  const { settings, key } = await save('{}', {
    section: 'run',
    key: 'new',
    fields: preset({ runOn: 'local', cwd: 'src' }),
  });
  expect(key).toBe('run:Train');
  expect(settings.activeRunConfiguration).toBe('Train');
  const selection = configuredScript(settings, workspace, undefined, 'Train');
  expect(selection.program).toBe(path.join(workspace, 'src', 'train.py'));
  expect(selection.options).toMatchObject({ args: ['--label', 'one two'], cwd: 'src' });
  expect(fileRunsRemotely(settings, workspace, selection.program, 'Train')).toBe(false);
});

test('named modules resolve for remote launch with the selected interpreter', async () => {
  const baseline = JSON.stringify({
    targets: [{ name: 'Server', host: 'config-test-alias', sshConfigPath, context: 'src' }],
    interpreters: { Remote: { target: 'Server', path: '/opt/env/bin/python' } },
  });
  const { settings } = await save(baseline, {
    section: 'run',
    key: 'new',
    fields: preset({ kind: 'module', module: 'package.train', cwd: 'src', interpreter: 'Remote' }),
  });
  const selection = configuredScript(settings, workspace, '/ignored.py', 'Train');
  expect(selection).toMatchObject({
    module: 'package.train',
    interpreter: { path: '/opt/env/bin/python' },
  });
  expect(selection.program).toBeUndefined();
  expect(fileRunsRemotely(settings, workspace, undefined, 'Train')).toBe(true);
});

test('copies, renames and removes a run entry with the persisted selection', async () => {
  let result = await save('{}', { section: 'run', key: 'new', fields: preset() });
  result = await save(result.text, {
    section: 'run',
    key: 'new',
    copyFrom: 'Train',
    fields: preset({ name: 'Train copy', active: false }),
  });
  expect(Object.keys(result.settings.runConfigurations ?? {})).toEqual(['Train', 'Train copy']);
  expect(result.settings.activeRunConfiguration).toBe('Train');
  result = await save(result.text, {
    section: 'run',
    key: 'run:Train',
    fields: preset({ name: 'Experiment' }),
  });
  expect(result.settings.activeRunConfiguration).toBe('Experiment');
  result = await save(result.text, {
    section: 'run',
    key: 'run:Experiment',
    remove: true,
    fields: {},
  });
  expect(result.settings.activeRunConfiguration).toBeUndefined();
  expect(Object.keys(result.settings.runConfigurations ?? {})).toEqual(['Train copy']);
});

test('keeps credentials and existing environment values out of the Webview and retains them on save', async () => {
  const baseline = JSON.stringify({
    targets: [
      {
        name: 'Server',
        host: 'config-test-alias',
        sshConfigPath,
        password: 'password-secret',
        profiles: { test: { password: 'profile-secret' } },
      },
    ],
    runConfigurations: { Train: { program: 'src/train.py', env: { TOKEN: 'environment-secret' } } },
  });
  const initial = parseSettings(baseline);
  const rows = configurationRows(initial, 'src/train.py');
  expect(JSON.stringify(rows)).not.toMatch(/password-secret|profile-secret|environment-secret/);
  const server = await save(baseline, {
    section: 'servers',
    key: 'server:0',
    fields: { ...rows.servers[0].values, name: 'Remote' },
  });
  expect(server.settings.targets[0]).toMatchObject({
    password: 'password-secret',
    profiles: { test: { password: 'profile-secret' } },
  });
  const run = await save(server.text, {
    section: 'run',
    key: 'run:Train',
    fields: { ...rows.run[1].values, args: 'changed', env: [{ name: 'TOKEN', original: 'TOKEN' }] },
  });
  expect(run.settings.runConfigurations?.Train).toMatchObject({
    args: ['changed'],
    env: { TOKEN: 'environment-secret' },
  });
});

test('updates names used by saved runs and the workspace default when an interpreter is renamed', async () => {
  const baseline = JSON.stringify({
    interpreters: { Default: { path: 'python3' } },
    defaultInterpreter: 'Default',
    runConfigurations: { Train: { program: 'src/train.py', interpreter: 'Default' } },
    scripts: { 'src/train.py': { interpreter: 'Default' } },
  });
  const result = await save(baseline, {
    section: 'interpreters',
    key: 'python:Default',
    fields: { name: 'Updated', path: '/opt/env/bin/python', default: true },
  });
  expect(result.settings.defaultInterpreter).toBe('Updated');
  expect(result.settings.scripts?.['src/train.py'].interpreter).toBe('Updated');
  expect(result.settings.runConfigurations?.Train.interpreter).toBe('Updated');
  await expect(
    save(result.text, {
      section: 'interpreters',
      key: 'python:Updated',
      remove: true,
      fields: {},
    })
  ).rejects.toThrow('before removing it');
});

test('writes current-file arguments and project sync values while preserving unrelated JSONC', async () => {
  const result = await save('{\n  // keep\n  "syncMode": "off",\n  "uploadOnSave": false,\n}', {
    section: 'run',
    key: 'file',
    fields: { ...preset(), args: 'updated' },
  });
  expect(result.text).toContain('// keep');
  expect(result.settings.scripts?.['src/train.py'].args).toEqual(['updated']);
  expect(result.settings.syncMode).toBe('off');
  expect(result.settings.uploadOnSave).toBe(false);
  const sync = await save(result.text, {
    section: 'sync',
    key: 'project',
    fields: { syncMode: 'incremental', uploadOnSave: false },
  });
  expect(sync.settings.syncMode).toBe('incremental');
  expect(sync.settings.uploadOnSave).toBe(false);
});

test('persists synchronization mapping used by the normal target resolver', async () => {
  const created = await save('{}', {
    section: 'servers',
    key: 'new',
    fields: {
      name: 'Server',
      host: 'config-test-alias',
      sshConfigPath,
      auth: 'password',
      remotePath: '.',
    },
  });
  const { settings } = await save(created.text, {
    section: 'sync',
    key: 'server:0',
    fields: { context: 'src', remotePath: '/data/project', ignore: '/dataset/\n*.bin' },
  });
  const target = resolveTarget(
    settings.targets,
    workspace,
    path.join(workspace, 'src', 'train.py')
  );
  expect(target.config.connection.privateKeyPath).toBeUndefined();
  expect(target.config.ignore(path.join(workspace, 'src', 'sample.bin'))).toBe(true);
  expect(
    mapProjectPath(
      path.join(workspace, 'src', 'train.py'),
      target.service.baseDir,
      target.config.remotePath
    )
  ).toBe('/data/project/train.py');
});

test('rejects unsafe values and paths outside the project', async () => {
  await expect(
    save('{}', {
      section: 'run',
      key: 'new',
      fields: preset({ program: '../foreign.py' }),
    })
  ).rejects.toThrow('inside the workspace');
  await expect(
    save('{}', {
      section: 'run',
      key: 'new',
      fields: preset({ env: [{ name: 'BAD-NAME', value: 'abc' }] }),
    })
  ).rejects.toThrow('environment variable name');
  await expect(
    save('{}', {
      section: 'run',
      key: 'new',
      fields: preset({ kind: 'module', module: 'one ; two' }),
    })
  ).rejects.toThrow('Python module name');
});
