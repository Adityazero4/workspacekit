'use client';
import { useLayoutEffect, useState, type RefObject } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;

/**
 * How close two zoom levels must be to count as equal, so float error does not skip or repeat a step.
 *
 * @example
 * ```ts
 * const isZoomedIn = scale > fitScale + ZOOM_TOLERANCE;
 * ```
 */
export const ZOOM_TOLERANCE = 1e-6;

/**
 * An element's size in CSS px.
 *
 * @example
 * ```ts
 * const size: ElementSize = { width: element.clientWidth, height: element.clientHeight };
 * ```
 */
export interface ElementSize {
  width: number;
  height: number;
}

const nextStepUp = (scale: number): number =>
  (Math.floor(scale / ZOOM_STEP + ZOOM_TOLERANCE) + 1) * ZOOM_STEP;
const nextStepDown = (scale: number): number =>
  (Math.ceil(scale / ZOOM_STEP - ZOOM_TOLERANCE) - 1) * ZOOM_STEP;

/**
 * Moves from `current` towards `target`, clamped to 0.1–8, never past `current` the wrong way: zooming out
 * from a fit below 0.1 stays put rather than jumping in to 0.1.
 *
 * @example
 * ```ts
 * zoomTowards(0.05, 0.02); // 0.05
 * ```
 */
export function zoomTowards(current: number, target: number): number {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
  return target < current ? Math.min(current, clamped) : Math.max(current, clamped);
}

/**
 * The next zoom level in or out from `scale`: the next multiple of 0.25, within 0.1–8.
 *
 * @example
 * ```ts
 * stepZoom(0.6, 'in'); // 0.75
 * ```
 */
export function stepZoom(scale: number, direction: 'in' | 'out'): number {
  return zoomTowards(scale, direction === 'in' ? nextStepUp(scale) : nextStepDown(scale));
}

/**
 * The client size of `element`, kept current by a `ResizeObserver`; `{ width: 0, height: 0 }` until it
 * is measured.
 *
 * @example
 * ```tsx
 * const { width } = useElementSize(surface);
 * ```
 */
export function useElementSize(element: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const measure = (): void =>
      setSize((previous) =>
        previous.width === target.clientWidth && previous.height === target.clientHeight
          ? previous
          : { width: target.clientWidth, height: target.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
