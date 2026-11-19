import {
  configurationColumnMaximum,
  fitConfigurationColumnWidths,
  readConfigurationColumnWidths,
} from '../configurationLayout';

describe('configuration columns', () => {
  test('uses sensible values for missing or out-of-range preferences', () => {
    expect(readConfigurationColumnWidths({ categories: Infinity, entries: 900 })).toEqual({
      categories: 176,
      entries: 480,
    });
    expect(readConfigurationColumnWidths({ categories: 45, entries: '310' })).toEqual({
      categories: 120,
      entries: 232,
    });
  });

  test('fits both columns while keeping room for the editor and restoring preferred widths', () => {
    const desired = { categories: 300, entries: 440 };
    const fitted = fitConfigurationColumnWidths(desired, 720);
    expect(fitted.categories + fitted.entries).toBe(720 - 300 - 16);
    expect(fitted.categories).toBeGreaterThanOrEqual(120);
    expect(fitted.entries).toBeGreaterThanOrEqual(150);
    expect(fitConfigurationColumnWidths(desired, 1200)).toEqual(desired);
  });

  test('limits resizing one column against the current width of its neighbor', () => {
    const visible = { categories: 176, entries: 232 };
    expect(configurationColumnMaximum('categories', visible, 800)).toBe(252);
    expect(configurationColumnMaximum('entries', visible, 800)).toBe(308);
    expect(configurationColumnMaximum('entries', visible, 1800)).toBe(480);
  });
});
