const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
const UNIT_STEP = 1000;

/**
 * A byte count for people, in the user's locale: `4 bytes`, `2 kB`, `1.5 MB` (decimal units, one decimal
 * place).
 *
 * @example
 * ```ts
 * formatBytes(2048); // '2 kB' in English
 * ```
 */
export function formatBytes(size: number): string {
  let value = size;
  let unitIndex = 0;
  while (value >= UNIT_STEP && unitIndex < BYTE_UNITS.length - 1) {
    value /= UNIT_STEP;
    unitIndex++;
  }
  return new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: BYTE_UNITS[unitIndex],
    unitDisplay: unitIndex === 0 ? 'long' : 'short',
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value);
}

/**
 * A modification time for people, as a medium date and short time in the user's locale.
 *
 * @example
 * ```ts
 * formatModified(Date.UTC(2026, 9, 3, 14, 5)); // 'Oct 3, 2026, 2:05 PM' in English (UTC)
 * ```
 */
export function formatModified(mtimeMs: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(mtimeMs);
}
