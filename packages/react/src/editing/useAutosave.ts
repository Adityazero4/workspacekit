'use client';
import type { FsError } from '@workspacekit/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLatest } from '../renderers/useLatest';
import { createAutosaver, type AutosaverOptions, type SaveStatusKind } from './autosaver';

/**
 * Options of `useAutosave`.
 *
 * @example
 * ```ts
 * const options: UseAutosaveOptions = { value: draft, save, baseMtimeMs: loadedVersion };
 * ```
 */
export interface UseAutosaveOptions {
  /** The edited text; every new value is saved once changes pause. The first value is taken as saved. */
  value: string;
  save: AutosaverOptions['save'];
  /**
   * The version (`mtimeMs`) of the file `value` was loaded from, which saves expect. A new one that is not
   * a version this hook wrote is someone else's: while nothing is unsaved it becomes the base (load its text
   * into `value` too); while edits are unsaved `status` goes to `conflict` and stays there until
   * `keepMine` or `takeTheirs`, so their version is never overwritten.
   */
  baseMtimeMs?: number;
  /** Read once, when the hook mounts. Default 1000. */
  delayMs?: number;
}

/**
 * What `useAutosave` returns.
 *
 * @example
 * ```ts
 * const { status, error, flush, keepMine, takeTheirs }: AutosaveState = useAutosave({ value, save });
 * ```
 */
export interface AutosaveState {
  status: SaveStatusKind;
  error?: FsError;
  /** Saves now; resolves once the save settles, never rejects. */
  flush: () => Promise<void>;
  /**
   * Resolves a `conflict` with the edited text: saves `value` over the latest `baseMtimeMs`, so a version
   * written after that one is a conflict again. Resolves once the save settles, never rejects.
   */
  keepMine: () => Promise<void>;
  /**
   * Resolves a `conflict` with their text: drops the unsaved edits and takes the latest `baseMtimeMs` as
   * the base. Set `value` to their text in the same update; the `value` of the next render is taken as
   * saved, not saved again.
   */
  takeTheirs: () => void;
}

function useChangesReported(value: string, report: (value: string) => void): () => void {
  const reported = useRef(value);
  const [adoptRequests, setAdoptRequests] = useState(0);
  const adoptedRequest = useRef(adoptRequests);
  useEffect(() => {
    if (adoptedRequest.current !== adoptRequests) {
      adoptedRequest.current = adoptRequests;
      reported.current = value;
      return;
    }
    if (value === reported.current) return;
    reported.current = value;
    report(value);
  }, [value, report, adoptRequests]);
  return () => setAdoptRequests((requests) => requests + 1);
}

/**
 * `createAutosaver` for a custom editor: saves `value` a second after it stops changing, one save at a
 * time, with `expectedMtimeMs`. `save` may change on every render; the latest one is used. Unmounting
 * saves what is pending (best effort, as nothing can wait for it) and then stops.
 *
 * `baseMtimeMs` is the version `value` was loaded from. When a newer version arrives while edits are
 * unsaved, nothing is saved over it: `status` is `conflict` until `keepMine` (save the edits over their
 * version) or `takeTheirs` (load their text instead).
 *
 * @example
 * ```tsx
 * const viewer = useFileViewer(path, { renderers: [textRenderer] });
 * const theirText = viewer.source?.kind === 'text' ? viewer.source.text : '';
 * const [draft, setDraft] = useState(theirText);
 * const autosave = useAutosave({
 *   value: draft,
 *   save: (text, expectedMtimeMs) => adapter.write!(path, text, { expectedMtimeMs }),
 *   baseMtimeMs: viewer.version,
 * });
 * const takeTheirs = () => {
 *   autosave.takeTheirs();
 *   setDraft(theirText);
 * };
 * ```
 */
export function useAutosave(options: UseAutosaveOptions): AutosaveState {
  const { value, baseMtimeMs } = options;
  const save = useLatest(options.save);
  const latestBase = useLatest(baseMtimeMs);
  const [autosaver] = useState(() =>
    createAutosaver({
      save: (text, expectedMtimeMs) => save.current(text, expectedMtimeMs),
      baseMtimeMs,
      delayMs: options.delayMs,
    }),
  );
  const status = useSyncExternalStore(autosaver.subscribe, autosaver.status, autosaver.status);
  useEffect(() => autosaver.noteServerVersion(baseMtimeMs), [autosaver, baseMtimeMs]);
  const adoptNextValue = useChangesReported(value, autosaver.change);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void autosaver.flush().then(() => {
        if (!mounted.current) autosaver.dispose();
      });
    };
  }, [autosaver]);
  return {
    status: status.kind,
    error: status.error,
    flush: autosaver.flush,
    keepMine: () => {
      autosaver.rebase(latestBase.current);
      return autosaver.flush();
    },
    takeTheirs: () => {
      autosaver.discard(latestBase.current);
      adoptNextValue();
    },
  };
}
