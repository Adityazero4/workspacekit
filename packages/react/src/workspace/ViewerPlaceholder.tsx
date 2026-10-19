'use client';
import { basename } from '@scope/core';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { useEntryState } from '../provider/hooks';

const BYTES_PER_UNIT = 1024;
const LARGER_UNITS = ['KB', 'MB', 'GB', 'TB'];

function formattedSize(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  let value = bytes / BYTES_PER_UNIT;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < LARGER_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${LARGER_UNITS[unit]}`;
}

function OpenFileWithoutAViewer(props: { path: string }): string {
  const { entry } = useEntryState(props.path);
  const size = typeof entry?.size === 'number' ? ` (${formattedSize(entry.size)})` : '';
  return `There is no viewer for "${basename(props.path)}"${size} yet.`;
}

/**
 * What the workspace's viewer area shows without a viewer: a prompt to open a file, or, for an open file, its
 * name and size and that it has no viewer yet.
 *
 * @example
 * ```tsx
 * <ViewerPlaceholder path={tabs.active ?? undefined} />
 * ```
 */
export function ViewerPlaceholder(props: { path?: string; classNames?: ClassNames }): React.JSX.Element {
  const { path, classNames } = props;
  return (
    <p {...partProps('viewer-placeholder', classNames)}>
      {path === undefined ? 'Select a file to open it.' : <OpenFileWithoutAViewer path={path} />}
    </p>
  );
}
