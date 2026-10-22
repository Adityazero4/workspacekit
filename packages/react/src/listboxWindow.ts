'use client';
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

/**
 * The options of a virtualized listbox to render now, and how to reach one that is off screen.
 *
 * @example
 * ```ts
 * const { items, totalSize }: ListboxWindow = useListboxWindow(options);
 * ```
 */
export interface ListboxWindow {
  items: VirtualItem[];
  totalSize: number;
  scrollToIndex: (index: number) => void;
  measureElement: (element: Element | null) => void;
}

const OVERSCAN = 4;
const OPTIONS_IN_FIRST_PAINT = 8;

/**
 * Virtualizes the `count` options of a listbox whose active option is pointed at with
 * `aria-activedescendant`. The option at `activeIndex` (`-1` for none) is always rendered, so that id never
 * points at a missing element. Options are measured (pass `measureElement` as their `ref`, with
 * `data-index`), so they can grow with the font size.
 *
 * @example
 * ```tsx
 * const listboxWindow = useListboxWindow(entries.length, activeIndex, viewportRef, 28);
 * ```
 */
export function useListboxWindow(
  count: number,
  activeIndex: number,
  viewport: RefObject<HTMLElement | null>,
  estimatedOptionHeight: number,
): ListboxWindow {
  'use no memo';
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => viewport.current,
    estimateSize: () => estimatedOptionHeight,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: OPTIONS_IN_FIRST_PAINT * estimatedOptionHeight },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
  });
  return {
    items: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollToIndex: (index) => virtualizer.scrollToIndex(index),
    measureElement: virtualizer.measureElement,
  };
}
