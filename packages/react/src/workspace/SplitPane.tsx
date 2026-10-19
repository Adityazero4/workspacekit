'use client';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { useUiValue } from '../provider/hooks';
import { useElementWidth } from './useElementWidth';
import { createPersister, readPersisted } from '../provider/persist';
import { createUiStore, type UiStore } from '../provider/ui-store';

/**
 * Props of `SplitPane`.
 *
 * @example
 * ```tsx
 * const props: SplitPaneProps = { storageKey: 'my-app', defaultSize: 300, children: [<Tree />, <Viewer />] };
 * ```
 */
export interface SplitPaneProps {
  /** Persists the first pane's width under `${storageKey}:pane`, like the provider's other UI state. */
  storageKey?: string;
  /** The first pane's width in pixels. Default 280. */
  defaultSize?: number;
  /** The first pane's smallest width in pixels. Default 160. */
  min?: number;
  /**
   * The first pane's largest width in pixels. Default 60% of the split pane's width. Either way it is lowered
   * while the split pane is too narrow to leave 240 px for the separator and the second pane.
   */
  max?: number;
  /** Lays the panes out top to bottom, without the separator. Default `false`. */
  stacked?: boolean;
  classNames?: ClassNames;
  children: [ReactNode, ReactNode];
}

const KEYBOARD_STEP_PX = 16;
const ROOM_KEPT_FOR_THE_SECOND_PANE_PX = 240;
const DEFAULT_MAX_SHARE_OF_THE_WIDTH = 0.6;
const PRIMARY_BUTTON = 0;

interface PointerDrag {
  startX: number;
  startSize: number;
  latestSize: number;
  frame: number | null;
}

const clamp = (size: number, min: number, max: number): number => Math.min(Math.max(size, min), max);

function sizeForKey(key: string, size: number, min: number, max: number): number | undefined {
  switch (key) {
    case 'ArrowLeft':
      return size - KEYBOARD_STEP_PX;
    case 'ArrowRight':
      return size + KEYBOARD_STEP_PX;
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return undefined;
  }
}

function useSizeRestoredAndPersisted(storageKey: string | undefined, size: UiStore<number>): void {
  useEffect(() => {
    if (!storageKey) return undefined;
    const restored = readPersisted(storageKey, 'pane');
    if (typeof restored === 'number' && Number.isFinite(restored)) size.set(restored);
    const persister = createPersister(storageKey);
    const stopPersisting = size.subscribe(() => persister.write('pane', size.get()));
    return () => {
      stopPersisting();
      persister.dispose();
    };
  }, [storageKey, size]);
}

function largestFirstPaneSize(
  min: number,
  max: number | undefined,
  defaultSize: number,
  containerWidth: number,
): number {
  if (containerWidth <= 0) return max ?? Math.max(min, defaultSize);
  const largest = max ?? Math.floor(containerWidth * DEFAULT_MAX_SHARE_OF_THE_WIDTH);
  return Math.max(min, Math.min(largest, containerWidth - ROOM_KEPT_FOR_THE_SECOND_PANE_PX));
}

function applyDefaultsOutsideParametersForReactCompiler(props: SplitPaneProps) {
  return {
    ...props,
    defaultSize: props.defaultSize ?? 280,
    min: props.min ?? 160,
  };
}

/**
 * Two panes side by side with a draggable separator between them, following the WAI-ARIA window splitter
 * pattern: the separator is focusable, Left and Right move it 16 px, and Home and End go to the first pane's
 * smallest and largest width. A pointer drag captures the pointer and applies the new width at most once per
 * animation frame, and only the split pane itself re-renders, never the panes' content. The width is
 * persisted under `storageKey`; a restored width is clamped to the current `min` and `max` (lowered so the
 * second pane keeps 240 px; before the split pane has been measured, a `max` left to its default is the
 * default size), and one that is not a number is ignored. With `stacked`, the panes are laid out top to
 * bottom and the separator is not rendered.
 *
 * @example
 * ```tsx
 * <SplitPane storageKey="my-app" min={200}>
 *   <FileTree />
 *   <Viewer />
 * </SplitPane>
 * ```
 */
export function SplitPane(props: SplitPaneProps): React.JSX.Element {
  const {
    storageKey,
    defaultSize,
    min,
    max: maxProp,
    stacked,
    classNames,
    children,
  } = applyDefaultsOutsideParametersForReactCompiler(props);
  const container = useRef<HTMLDivElement>(null);
  const max = largestFirstPaneSize(min, maxProp, defaultSize, useElementWidth(container));
  const [first, second] = children;
  const [sizeStore] = useState(() => createUiStore(defaultSize));
  useSizeRestoredAndPersisted(storageKey, sizeStore);
  const size = clamp(useUiValue(sizeStore), min, max);
  const firstPaneId = useId();
  const drag = useRef<PointerDrag | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (): void => {
    const session = drag.current;
    if (!session) return;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    sizeStore.set(session.latestSize);
    drag.current = null;
    setDragging(false);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== PRIMARY_BUTTON) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startSize: size, latestSize: size, frame: null };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const session = drag.current;
    if (!session) return;
    session.latestSize = clamp(session.startSize + event.clientX - session.startX, min, max);
    if (session.frame !== null) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = null;
      sizeStore.set(session.latestSize);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next = sizeForKey(event.key, size, min, max);
    if (next === undefined) return;
    event.preventDefault();
    sizeStore.set(clamp(next, min, max));
  };

  return (
    <div ref={container} {...partProps('split-pane', classNames)}>
      <div
        id={firstPaneId}
        {...partProps('workspace-pane', classNames)}
        style={stacked ? undefined : { width: size }}
      >
        {first}
      </div>
      {!stacked && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a focusable separator is a widget (WAI-ARIA window splitter)
        <div
          role="separator"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a focusable separator is a widget (WAI-ARIA window splitter)
          tabIndex={0}
          aria-label="Resize panes"
          aria-orientation="vertical"
          aria-controls={firstPaneId}
          aria-valuenow={size}
          aria-valuemin={min}
          aria-valuemax={max}
          {...partProps('workspace-separator', classNames)}
          data-dragging={dragging ? '' : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        />
      )}
      <div {...partProps('workspace-pane', classNames)}>{second}</div>
    </div>
  );
}
