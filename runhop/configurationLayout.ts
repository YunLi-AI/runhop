export const configurationColumns = {
  categories: { min: 120, max: 320, initial: 176 },
  entries: { min: 150, max: 480, initial: 232 },
} as const;

export type ConfigurationColumn = keyof typeof configurationColumns;
export type ConfigurationColumnWidths = Record<ConfigurationColumn, number>;

const minimumDetailsWidth = 300;
const combinedDividerWidth = 16;

function columnWidth(key: ConfigurationColumn, value: unknown) {
  const { min, max, initial } = configurationColumns[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : initial;
}

export function readConfigurationColumnWidths(value: unknown): ConfigurationColumnWidths {
  const widths =
    value && typeof value === 'object' ? (value as Partial<ConfigurationColumnWidths>) : {};
  return {
    categories: columnWidth('categories', widths.categories),
    entries: columnWidth('entries', widths.entries),
  };
}

function sidebarCapacity(layoutWidth: number): number {
  return Math.max(
    configurationColumns.categories.min + configurationColumns.entries.min,
    Math.floor(layoutWidth) - minimumDetailsWidth - combinedDividerWidth
  );
}

export function fitConfigurationColumnWidths(
  preferred: ConfigurationColumnWidths,
  layoutWidth: number
): ConfigurationColumnWidths {
  const room = sidebarCapacity(layoutWidth);
  const preferredTotal = preferred.categories + preferred.entries;
  if (preferredTotal <= room) return preferred;

  const categoryMinimum = configurationColumns.categories.min;
  const minimumTotal = categoryMinimum + configurationColumns.entries.min;
  const fit = (room - minimumTotal) / (preferredTotal - minimumTotal);
  const categories = categoryMinimum + Math.round((preferred.categories - categoryMinimum) * fit);
  return { categories, entries: room - categories };
}

export function configurationColumnMaximum(
  key: ConfigurationColumn,
  visible: ConfigurationColumnWidths,
  layoutWidth: number
): number {
  const other = key === 'categories' ? 'entries' : 'categories';
  return Math.min(configurationColumns[key].max, sidebarCapacity(layoutWidth) - visible[other]);
}
