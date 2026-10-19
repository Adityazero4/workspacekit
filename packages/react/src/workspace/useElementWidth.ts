'use client';
import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The border-box width of `element` in pixels: measured in a layout effect, before the first paint, then kept
 * current with a `ResizeObserver`; 0 on the server and in the first render.
 *
 * @example
 * ```ts
 * const width = useElementWidth(rootRef);
 * const narrow = width > 0 && width < 640;
 * ```
 */
export function useElementWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return undefined;
    const measure = (): void => setWidth(target.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}
