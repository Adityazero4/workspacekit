'use client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState, type RefObject } from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';

const OVERSCAN = 10;
const LINES_IN_FIRST_PAINT = 40;

/**
 * Props of `LineView`.
 *
 * @example
 * ```tsx
 * const props: LineViewProps = { text: log, label: 'Contents of build.log' };
 * ```
 */
export interface LineViewProps {
  text: string;
  label: string;
  classNames?: ClassNames;
}

/**
 * A read-only, virtualized view of a large text, one `text-line` part per line, all lines as tall as the
 * first one measured (set their height in CSS, not per line). It is a focusable `role="document"`, so the
 * keyboard can scroll it.
 *
 * @example
 * ```tsx
 * <LineView text={hugeLog} label="Contents of build.log" />
 * ```
 */
export function LineView(props: LineViewProps): React.JSX.Element {
  const { text, label, classNames } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState<number>();
  const measureLineHeight = (probe: HTMLDivElement | null): void => {
    if (probe) setLineHeight(probe.getBoundingClientRect().height);
  };
  const lines = text.split('\n');
  return (
    <div
      ref={viewport}
      {...partProps('text-lines', classNames)}
      role="document"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable view must take focus so the keyboard can scroll it
      tabIndex={0}
    >
      {lineHeight === undefined ? (
        <div ref={measureLineHeight} {...partProps('text-line', classNames)} aria-hidden="true">
          {' '}
        </div>
      ) : (
        <VirtualLines lines={lines} lineHeight={lineHeight} viewport={viewport} classNames={classNames} />
      )}
    </div>
  );
}

function VirtualLines(props: {
  lines: readonly string[];
  lineHeight: number;
  viewport: RefObject<HTMLDivElement | null>;
  classNames?: ClassNames;
}): React.JSX.Element {
  'use no memo';
  const { lines, lineHeight, viewport, classNames } = props;
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this component uncompiled; the virtualizer returns fresh values every render
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => lineHeight,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: LINES_IN_FIRST_PAINT * lineHeight },
  });
  return (
    <div {...partProps('text-line-list', classNames)} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.index}
          {...partProps('text-line', classNames)}
          style={{ transform: `translateY(${item.start}px)` }}
        >
          {lines[item.index]!.replace(/\r$/, '')}
        </div>
      ))}
    </div>
  );
}
