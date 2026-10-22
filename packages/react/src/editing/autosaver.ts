import { FsError, toFsError, type Entry } from '@scope/core';

/**
 * Where an edited text stands: nothing edited (`idle`), edits waiting (`dirty`), a save in flight
 * (`saving`), everything saved (`saved`), the last save failed (`error`), the file changed on the server
 * (`conflict`), or the file was deleted (`deleted`).
 *
 * @example
 * ```ts
 * const unsaved = (kind: SaveStatusKind): boolean => kind !== 'idle' && kind !== 'saved';
 * ```
 */
export type SaveStatusKind = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict' | 'deleted';

/**
 * Whether a text with this status has edits that are not saved: anything but `idle` and `saved`.
 *
 * @example
 * ```ts
 * if (hasUnsavedEdits(autosaver.status().kind)) askBeforeLeaving();
 * ```
 */
export function hasUnsavedEdits(kind: SaveStatusKind): boolean {
  return kind !== 'idle' && kind !== 'saved';
}

/**
 * Options of `createAutosaver`.
 *
 * @example
 * ```ts
 * const options: AutosaverOptions = {
 *   save: (text, expectedMtimeMs) => adapter.write!(path, text, { expectedMtimeMs }),
 *   baseMtimeMs: entry.mtimeMs,
 * };
 * ```
 */
export interface AutosaverOptions {
  /** Writes `text`, refusing with a `conflict` `FsError` when the file is no longer at `expectedMtimeMs`. */
  save: (text: string, expectedMtimeMs: number | undefined) => Promise<Entry>;
  /** How long after the last change the text is saved. Default 1000. */
  delayMs?: number;
  /** The `mtimeMs` of the version the text was edited from. */
  baseMtimeMs: number | undefined;
}

/**
 * A debounced saver for one text; see `createAutosaver`.
 *
 * @example
 * ```ts
 * const autosaver: Autosaver = createAutosaver({ save, baseMtimeMs: entry.mtimeMs });
 * ```
 */
export interface Autosaver {
  /** Records the latest text and saves it once changes pause. */
  change: (text: string) => void;
  /** Saves the latest text now (also after an error); resolves once that settles, never rejects. */
  flush: () => Promise<void>;
  /** The current status; the same object until it changes. */
  status: () => { kind: SaveStatusKind; error?: FsError; savedAt?: number };
  /** Calls `listener` on every status change. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Cancels the pending save and stops all saving and notifying. */
  dispose: () => void;
  /** Sets the version the next save expects, and leaves `conflict` (after Keep mine or Take theirs). */
  rebase: (mtimeMs: number | undefined) => void;
  /**
   * Reports the version (`mtimeMs`) the server holds now, such as a newer `entry.mtimeMs`. A version this
   * autosaver did not edit from or write is someone else's: with nothing unsaved it becomes the base, and
   * with unsaved edits the status goes to `conflict` (never back out of it). A report made while a save is
   * in flight is checked once that save settles, so the echo of the save itself is never a conflict.
   */
  noteServerVersion: (mtimeMs: number | undefined) => void;
  /**
   * Drops the unsaved text and the pending save, takes `mtimeMs` as the base, and leaves `conflict` (after
   * Take theirs).
   */
  discard: (mtimeMs: number | undefined) => void;
}

type AutosaverStatus = ReturnType<Autosaver['status']>;

const DEFAULT_DELAY_MS = 1000;
const IDLE: AutosaverStatus = { kind: 'idle' };
const DIRTY: AutosaverStatus = { kind: 'dirty' };
const SAVING: AutosaverStatus = { kind: 'saving' };

const saveWithoutThrowing = (
  save: AutosaverOptions['save'],
  text: string,
  expectedMtimeMs: number | undefined,
): Promise<Entry> => {
  try {
    return save(text, expectedMtimeMs);
  } catch (thrown) {
    return Promise.reject(toFsError(thrown));
  }
};

const statusAfterFailure = (thrown: unknown): AutosaverStatus => {
  const error = toFsError(thrown);
  return { kind: error.kind === 'conflict' ? 'conflict' : 'error', error };
};

interface StatusSignal {
  status: () => AutosaverStatus;
  setStatus: (next: AutosaverStatus) => void;
  subscribe: (listener: () => void) => () => void;
  silence: () => void;
}

function createStatusSignal(): StatusSignal {
  const listeners = new Set<() => void>();
  let status = IDLE;
  let silenced = false;
  return {
    status: () => status,
    setStatus: (next) => {
      if (next === status || silenced) return;
      status = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    silence: () => {
      silenced = true;
      listeners.clear();
    },
  };
}

class TextAutosaver implements Autosaver {
  readonly #save: AutosaverOptions['save'];
  readonly #delayMs: number;
  readonly #signal = createStatusSignal();
  readonly #knownVersions = new Set<number>();
  #baseMtimeMs: number | undefined;
  #serverVersionToCheck: number | undefined;
  #latestText = '';
  #unsaved = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saveInFlight: Promise<void> | undefined;
  #disposed = false;

  constructor(options: AutosaverOptions) {
    this.#save = options.save;
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.#setBase(options.baseMtimeMs);
  }

  status = (): AutosaverStatus => this.#signal.status();

  subscribe = (listener: () => void): (() => void) => this.#signal.subscribe(listener);

  change = (text: string): void => {
    if (this.#disposed) return;
    this.#latestText = text;
    this.#unsaved = true;
    const { kind } = this.status();
    if (kind === 'conflict') return;
    if (kind === 'idle' || kind === 'saved') this.#signal.setStatus(DIRTY);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), this.#delayMs);
  };

  flush = async (): Promise<void> => {
    clearTimeout(this.#timer);
    while (this.#saveInFlight) await this.#saveInFlight;
    if (this.#disposed || !this.#unsaved || this.status().kind === 'conflict') return;
    this.#saveInFlight = this.#startSave().finally(() => {
      this.#saveInFlight = undefined;
      this.#checkServerVersion();
    });
    await this.#saveInFlight;
  };

  dispose = (): void => {
    clearTimeout(this.#timer);
    this.#disposed = true;
    this.#signal.silence();
  };

  rebase = (mtimeMs: number | undefined): void => {
    this.#setBase(mtimeMs);
    if (this.status().kind === 'conflict') this.#signal.setStatus(this.#unsaved ? DIRTY : IDLE);
  };

  noteServerVersion = (mtimeMs: number | undefined): void => {
    if (mtimeMs === undefined || this.#knownVersions.has(mtimeMs)) return;
    this.#serverVersionToCheck = mtimeMs;
    this.#checkServerVersion();
  };

  discard = (mtimeMs: number | undefined): void => {
    clearTimeout(this.#timer);
    this.#unsaved = false;
    this.#serverVersionToCheck = undefined;
    this.#setBase(mtimeMs);
    this.#signal.setStatus(IDLE);
  };

  #setBase(mtimeMs: number | undefined): void {
    this.#baseMtimeMs = mtimeMs;
    if (mtimeMs !== undefined) this.#knownVersions.add(mtimeMs);
  }

  #checkServerVersion(): void {
    const mtimeMs = this.#serverVersionToCheck;
    if (mtimeMs === undefined || this.#saveInFlight || this.#disposed) return;
    this.#serverVersionToCheck = undefined;
    if (this.#knownVersions.has(mtimeMs)) return;
    if (!hasUnsavedEdits(this.status().kind)) {
      this.#setBase(mtimeMs);
      return;
    }
    if (this.status().kind === 'conflict') return;
    clearTimeout(this.#timer);
    const error = new FsError(
      'conflict',
      'The file was changed by someone else; keep your text or take theirs',
    );
    this.#signal.setStatus({ kind: 'conflict', error });
  }

  #startSave(): Promise<void> {
    const sent = this.#latestText;
    this.#unsaved = false;
    this.#signal.setStatus(SAVING);
    return saveWithoutThrowing(this.#save, sent, this.#baseMtimeMs).then(
      (entry) => {
        this.#setBase(entry.mtimeMs);
        this.#unsaved = this.#latestText !== sent;
        this.#signal.setStatus(this.#unsaved ? DIRTY : { kind: 'saved', savedAt: Date.now() });
      },
      (thrown: unknown) => {
        this.#unsaved = true;
        this.#signal.setStatus(statusAfterFailure(thrown));
      },
    );
  }
}

/**
 * Saves a text as it is edited, without React. The latest text is saved `delayMs` after the last change,
 * one save at a time: a change made while a save is in flight is saved next. Only the text a save sent is
 * marked saved, so typing during a save never reads as saved. Every save passes `expectedMtimeMs` (the
 * version the text is based on), and a successful save moves that to the returned entry's `mtimeMs`. A
 * `conflict` failure stops saving until `rebase`; any other failure is `error`, retried on the next change
 * or `flush`. `noteServerVersion` tells it about newer versions on the server: someone else's version is a
 * `conflict` while edits are unsaved, and the new base otherwise. `save` is called synchronously (so a save
 * started during `pagehide` reaches the network), and a `save` that throws instead of rejecting is a
 * failure like any other.
 *
 * @example
 * ```ts
 * const autosaver = createAutosaver({
 *   save: (text, expectedMtimeMs) => adapter.write!('notes.md', text, { expectedMtimeMs }),
 *   baseMtimeMs: entry.mtimeMs,
 * });
 * textarea.addEventListener('input', () => autosaver.change(textarea.value));
 * ```
 */
export function createAutosaver(options: AutosaverOptions): Autosaver {
  return new TextAutosaver(options);
}
