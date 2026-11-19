import * as path from 'node:path';
import { fileRunsRemotely, presetsForFile } from '../fileLaunch';
import { configuredScript, parseSettings } from '../settings';

const workspace = path.resolve('workspace');
const current = path.join(workspace, 'remote', 'script.py');
const outside = path.join(workspace, 'local.py');
const target = { host: 'example', name: 'Dev', context: 'remote' };
const defaultInterpreter = 'Project Python';
const interpreters = {
  [defaultInterpreter]: { path: '/project/bin/python', target: 'Dev' },
  Script: { path: '/script/bin/python', target: 'Dev' },
  Preset: { path: '/preset/bin/python', target: 'Dev' },
};

describe('Python file launches', () => {
  test('chooses only configurations for the clicked file', () => {
    const settings = {
      targets: [target],
      runConfigurations: {
        Other: { program: 'local.py' },
        Eval: { program: 'remote/script.py' },
        Train: { program: 'remote/./script.py' },
      },
    };
    expect(
      presetsForFile({ ...settings, activeRunConfiguration: 'Other' }, workspace, current)
    ).toEqual(['Eval', 'Train']);
    expect(
      presetsForFile({ ...settings, activeRunConfiguration: 'Train' }, workspace, current)
    ).toEqual(['Train']);
    expect(presetsForFile(settings, workspace, outside)).toEqual(['Other']);
  });

  test('uses a target mapping and falls back to local for files outside it', () => {
    const settings = { targets: [target], defaultInterpreter, interpreters };
    expect(fileRunsRemotely(undefined, workspace, current)).toBe(false);
    expect(fileRunsRemotely(settings, workspace, current)).toBe(true);
    expect(fileRunsRemotely(settings, workspace, outside)).toBe(false);
    expect(configuredScript(settings, workspace, current).interpreter).toEqual(
      interpreters[defaultInterpreter]
    );
  });

  test('honors script and preset interpreter names in order', () => {
    const settings = {
      targets: [target],
      defaultInterpreter,
      interpreters,
      scripts: { 'remote/script.py': { interpreter: 'Script' } },
      runConfigurations: {
        Inherited: { program: 'remote/script.py' },
        Specific: { program: 'remote/script.py', interpreter: 'Preset' },
      },
    };
    expect(configuredScript(settings, workspace, current, 'Inherited').interpreter).toEqual(
      interpreters.Script
    );
    expect(configuredScript(settings, workspace, current, 'Specific').interpreter).toEqual(
      interpreters.Preset
    );
  });

  test('lets a local override ignore remote defaults and accepts a local-only project', () => {
    const settings = parseSettings(
      JSON.stringify({
        defaultInterpreter: 'Unknown remote interpreter',
        scripts: { 'remote/script.py': { runOn: 'local', args: ['one argument'] } },
      })
    );
    expect(settings.targets).toEqual([]);
    expect(fileRunsRemotely({ ...settings, targets: [target] }, workspace, current)).toBe(false);
    expect(configuredScript(settings, workspace, current).interpreter).toBeUndefined();
  });

  test('retains explicit remote intent when no target covers the file', () => {
    const settings = parseSettings(
      JSON.stringify({
        targets: [target],
        scripts: { 'local.py': { runOn: 'remote' } },
      })
    );
    expect(fileRunsRemotely(settings, workspace, outside)).toBe(true);
  });
});
