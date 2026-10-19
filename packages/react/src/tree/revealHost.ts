'use client';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { FileSystemContext } from '../provider/hooks';
import { internalsOf } from '../provider/internals';
import { createUiStore, type UiStore } from '../provider/ui-store';
import type { RovingFocusController } from './rovingFocus';

const FLASH_DURATION_WITHOUT_THE_STYLESHEET_MS = 1500;
const CSS_TIME = /^(\d*\.?\d+)(ms|s)$/;

function flashDurationMs(styledElement: Element | null): number {
  const element = styledElement ?? document.documentElement;
  const value = getComputedStyle(element).getPropertyValue('--fs-flash-duration').trim();
  const time = CSS_TIME.exec(value);
  if (!time) return FLASH_DURATION_WITHOUT_THE_STYLESHEET_MS;
  return Number(time[1]) * (time[2] === 's' ? 1000 : 1);
}

interface Flasher {
  flashing: UiStore<string | null>;
  flash: (path: string) => void;
  stop: () => void;
}

function createFlasher(controller: RovingFocusController): Flasher {
  const flashing = createUiStore<string | null>(null);
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let restartFrame: number | undefined;
  const stop = (): void => {
    clearTimeout(endTimer);
    if (restartFrame !== undefined) cancelAnimationFrame(restartFrame);
    restartFrame = undefined;
    flashing.set(null);
  };
  const start = (path: string): void => {
    restartFrame = undefined;
    flashing.set(path);
    endTimer = setTimeout(() => flashing.set(null), flashDurationMs(controller.treeElement()));
  };
  const restartAfterAFrameWithoutTheFlash = (path: string): void => {
    restartFrame = requestAnimationFrame(() => {
      restartFrame = requestAnimationFrame(() => start(path));
    });
  };
  return {
    flashing,
    stop,
    flash: (path) => {
      const isReplay = flashing.get() === path;
      stop();
      if (isReplay) restartAfterAFrameWithoutTheFlash(path);
      else start(path);
    },
  };
}

/**
 * Registers the tree with the provider as a reveal host while it is mounted. A revealed row is scrolled into
 * view and focused, taking focus from outside the tree, or with `focus: false` only scrolled into view once
 * the tree has rendered it, leaving focus where it is; a request whose row is still not visible after the
 * next commit (a path under a hidden name) is dropped, so it never takes focus later. With `flash`, the row
 * becomes the flashing path for `--fs-flash-duration`, read from the tree's styles; revealing the flashing
 * row again replays the flash. A new reveal ends the previous flash, and so does unmounting. Returns the
 * identity-stable store of the flashing path.
 *
 * @example
 * ```ts
 * const flashing = useRevealHost(fs, rovingFocus.controller);
 * ```
 */
export function useRevealHost(
  fs: FileSystemContext,
  controller: RovingFocusController,
): UiStore<string | null> {
  const [{ flasher, showCount }] = useState(() => ({
    flasher: createFlasher(controller),
    showCount: createUiStore(0),
  }));
  const shown = useSyncExternalStore(showCount.subscribe, showCount.get, showCount.get);
  const { attachRevealHost } = internalsOf(fs);
  useLayoutEffect(() => controller.settleFocusWaitingToBeVisible(), [controller, shown]);
  useEffect(() => {
    const detach = attachRevealHost({
      show: (path, { flash, focus }) => {
        if (focus) controller.focusPathOnceVisible(path, { fromOutsideTheTree: true });
        else controller.scrollPathIntoViewAfterRender(path);
        showCount.set((count) => count + 1);
        if (flash) flasher.flash(path);
        else flasher.stop();
      },
    });
    return () => {
      detach();
      flasher.stop();
    };
  }, [attachRevealHost, controller, flasher, showCount]);
  return flasher.flashing;
}

/**
 * Whether `path` is the row a reveal is flashing; re-renders only when that changes.
 *
 * @example
 * ```tsx
 * const isFlashing = useIsFlashing(shared.flashing, path);
 * ```
 */
export function useIsFlashing(flashing: UiStore<string | null>, path: string): boolean {
  const read = (): boolean => flashing.get() === path;
  return useSyncExternalStore(flashing.subscribe, read, read);
}
