import { launchSyncMode, parseSettings } from '../settings';

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
});
