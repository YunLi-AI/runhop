import { launchSyncMode, parseSettings, proxyEnvironment } from '../settings';

describe('RunHop configuration', () => {
  const targets = [{ host: 'ssh-target', remotePath: '/opt/project' }];

  test('defaults to incremental deployment and supports per-launch overrides', () => {
    const defaults = parseSettings(JSON.stringify({ targets }));
    expect(launchSyncMode(defaults)).toBe('incremental');
    const manual = parseSettings(JSON.stringify({ targets, syncMode: 'off' }));
    expect(launchSyncMode(manual)).toBe('off');
    expect(launchSyncMode(manual, 'full')).toBe('full');
  });

  test('requires the project structure and explicit sync modes', () => {
    expect(() => parseSettings(JSON.stringify(targets))).toThrow(/targets array/);
    expect(() => parseSettings(JSON.stringify({ targets, syncBeforeLaunch: false }))).toThrow(
      /syncMode/
    );
    expect(() => parseSettings(JSON.stringify({ targets, syncMode: true }))).toThrow(/syncMode/);
  });

  test('accepts explicit conflict policies and maps a launch proxy to standard variables', () => {
    const settings = parseSettings(
      JSON.stringify({ targets, uploadPolicy: 'interactive', proxy: 'http://127.0.0.1:7890' })
    );
    expect(settings.uploadPolicy).toBe('interactive');
    expect(proxyEnvironment(settings.proxy).HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(() => parseSettings(JSON.stringify({ targets, syncPolicy: 'overwrite' }))).toThrow(
      /syncPolicy/
    );
  });
});
