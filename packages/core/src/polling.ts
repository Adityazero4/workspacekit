import { isFsError, type FsError } from './errors';
import { normalizedOrUndefined } from './adapter-paths';
import { isSameOrDescendant, parentPath } from './path';
import type { ChangeEvent, Entry, FileSystemAdapter, UploadTransport, WatchOptions } from './types';

/**
 * Options for `withPolling`: which folders to poll each round, how often, and when to pause.
 *
 * @example
 * ```ts
 * const options: PollingOptions = {
 *   paths: () => ['', ...expandedFolders],
 *   isPaused: () => document.hidden,
 * };
 * ```
 */
export interface PollingOptions {
  /** The folders to poll this round, most important first; read again before every round. */
  paths: () => readonly string[];
  /** The delay between rounds, and the first backoff step. Default 3000. */
  intervalMs?: number;
  /** The longest delay that failed rounds back off to. Default 30000. */
  maxIntervalMs?: number;
  /** Only the first this many distinct `paths` are polled in one round. Default 50. */
  maxFoldersPerRound?: number;
  /** While it returns true, rounds poll nothing, such as `() => document.hidden`. */
  isPaused?: () => boolean;
  /**
   * Subscribes `poll` to the moment polling should resume, such as `visibilitychange`, and returns the
   * unsubscribe. `poll` runs a round at once unless paused or a round is running; sooner than the current
   * delay (the interval, or the backoff after failures) since the last round started, it waits out the rest
   * of that delay instead.
   */
  resumeSignal?: (poll: () => void) => () => void;
  /**
   * Stops a subscription's polling for good once `rounds` rounds in a row had every folder they listed
   * refused (`forbidden`) with at least one refusal other than an HTTP 401, and calls `onGiveUp` once with
   * the last such refusal. Rounds refused only with 401 (a sign-in may fix it) and rounds that skipped
   * every folder while it backs off count for neither side; a round that lists a folder resets the count.
   */
  giveUpWhenDenied?: { rounds: number; onGiveUp: (error: FsError) => void };
}

type Listing = Map<string, Entry>;
type Timer = ReturnType<typeof setTimeout>;
interface OwnChange {
  path: string;
  entry: Entry | undefined;
}
interface PollRound {
  events: ChangeEvent[];
  failed: boolean;
  listed: number;
  refusals: number;
  lastRefusalSignInWontFix: FsError | undefined;
}
interface OwnChangeNotes {
  noteOwnEntry: (entry: Entry) => Entry;
  noteOwnRemoval: (path: string) => void;
}

const EXTERNAL = 'external';

function childrenListingOf(folder: string, entries: readonly Entry[]): Listing {
  const listing = listingOf(entries);
  for (const path of [...listing.keys()]) {
    if (path === folder || parentPath(path) !== folder) listing.delete(path);
  }
  return listing;
}

function listingOf(entries: readonly Entry[]): Listing {
  const listing: Listing = new Map();
  for (const entry of entries) {
    const path = normalizedOrUndefined(entry.path);
    if (path !== undefined) listing.set(path, path === entry.path ? entry : { ...entry, path });
  }
  return listing;
}

const isChangedFile = (previous: Entry, entry: Entry): boolean =>
  entry.kind === 'file' && (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs);

function changesBetween(before: Listing, after: Listing): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const [path, entry] of after) {
    const previous = before.get(path);
    const created: ChangeEvent = { type: 'created', path, actor: EXTERNAL, entry };
    if (!previous) events.push(created);
    else if (previous.kind !== entry.kind) events.push({ type: 'deleted', path, actor: EXTERNAL }, created);
    else if (isChangedFile(previous, entry)) events.push({ type: 'updated', path, actor: EXTERNAL, entry });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) events.push({ type: 'deleted', path, actor: EXTERNAL });
  }
  return events;
}

const isGoneFolder = (error: unknown): boolean =>
  isFsError(error) && (error.kind === 'not_found' || error.kind === 'invalid');

const UNAUTHORIZED_STATUS = 401;
const isDeniedFolder = (error: unknown): boolean => isFsError(error) && error.kind === 'forbidden';

const MOST_ROUNDS_SKIPPED_WHILE_DENIED = 10;

function applyOwnChange(listing: Listing | undefined, change: OwnChange): void {
  if (!listing) return;
  if (change.entry) listing.set(change.path, change.entry);
  else listing.delete(change.path);
}

class FolderBaselines implements OwnChangeNotes {
  constructor(readonly paths: () => readonly string[]) {}

  readonly #listings = new Map<string, Listing>();
  readonly #denied = new Map<string, { roundsToSkip: number; streak: number }>();
  readonly #ownChangesOfListingsInFlight = new Set<OwnChange[]>();
  readonly #appListingsNotYetPolled = new Map<
    string,
    { entries: readonly Entry[]; ownChanges: OwnChange[] }
  >();

  noteOwnEntry = (entry: Entry): Entry => {
    const path = normalizedOrUndefined(entry.path);
    if (path !== undefined) this.#noteOwn({ path, entry: path === entry.path ? entry : { ...entry, path } });
    return entry;
  };

  noteOwnRemoval = (path: string): void => {
    const removed = normalizedOrUndefined(path);
    if (removed === undefined) return;
    for (const folder of [...this.#listings.keys()]) {
      if (isSameOrDescendant(folder, removed)) this.#listings.delete(folder);
    }
    for (const folder of [...this.#appListingsNotYetPolled.keys()]) {
      if (isSameOrDescendant(folder, removed)) this.#forgetAppListing(folder);
    }
    this.#noteOwn({ path: removed, entry: undefined });
  };

  async poll(folders: readonly string[], list: (folder: string) => Promise<Entry[]>): Promise<PollRound> {
    const ownChangesDuringRound: OwnChange[] = [];
    this.#ownChangesOfListingsInFlight.add(ownChangesDuringRound);
    try {
      const listed = folders.filter((folder) => !this.#skipsDeniedFolderThisRound(folder));
      const results = await Promise.allSettled(listed.map(async (folder) => list(folder)));
      return this.#diff(listed, results, ownChangesDuringRound);
    } finally {
      this.#ownChangesOfListingsInFlight.delete(ownChangesDuringRound);
    }
  }

  keepTheAppsListingAsBaseline(folder: string): (entries: readonly Entry[] | undefined) => void {
    const ownChanges: OwnChange[] = [];
    this.#ownChangesOfListingsInFlight.add(ownChanges);
    return (entries) => {
      if (!entries || this.#listings.has(folder) || this.#appListingsNotYetPolled.has(folder)) {
        this.#ownChangesOfListingsInFlight.delete(ownChanges);
        return;
      }
      this.#appListingsNotYetPolled.set(folder, { entries, ownChanges });
    };
  }

  #forgetAppListing(folder: string): void {
    const appListing = this.#appListingsNotYetPolled.get(folder);
    if (!appListing) return;
    this.#appListingsNotYetPolled.delete(folder);
    this.#ownChangesOfListingsInFlight.delete(appListing.ownChanges);
  }

  #baselineOf(folder: string): Listing | undefined {
    const polled = this.#listings.get(folder);
    const appListing = this.#appListingsNotYetPolled.get(folder);
    if (polled || !appListing) return polled;
    this.#forgetAppListing(folder);
    const listing = childrenListingOf(folder, appListing.entries);
    for (const change of appListing.ownChanges) {
      if (parentPath(change.path) === folder) applyOwnChange(listing, change);
    }
    return listing;
  }

  #skipsDeniedFolderThisRound(folder: string): boolean {
    const denied = this.#denied.get(folder);
    if (!denied || denied.roundsToSkip === 0) return false;
    denied.roundsToSkip -= 1;
    return true;
  }

  #noteDenied(folder: string): void {
    const streak = (this.#denied.get(folder)?.streak ?? 0) + 1;
    this.#denied.set(folder, {
      streak,
      roundsToSkip: Math.min(2 ** (streak - 1), MOST_ROUNDS_SKIPPED_WHILE_DENIED),
    });
  }

  #noteOwn(change: OwnChange): void {
    applyOwnChange(this.#listings.get(parentPath(change.path)), change);
    for (const ownChanges of this.#ownChangesOfListingsInFlight) ownChanges.push(change);
  }

  #diff(
    folders: readonly string[],
    results: Array<PromiseSettledResult<Entry[]>>,
    ownChangesDuringRound: readonly OwnChange[],
  ): PollRound {
    const events: ChangeEvent[] = [];
    let failed = false;
    let refusals = 0;
    let lastRefusalSignInWontFix: FsError | undefined;
    results.forEach((result, index) => {
      const folder = folders[index]!;
      if (result.status === 'rejected') {
        if (isDeniedFolder(result.reason)) {
          this.#noteDenied(folder);
          refusals++;
          if ((result.reason as FsError).status !== UNAUTHORIZED_STATUS) {
            lastRefusalSignInWontFix = result.reason as FsError;
          }
        } else if (isGoneFolder(result.reason)) this.#listings.delete(folder);
        else failed = true;
        return;
      }
      this.#denied.delete(folder);
      const listing = childrenListingOf(folder, result.value);
      for (const change of ownChangesDuringRound) {
        if (parentPath(change.path) === folder) applyOwnChange(listing, change);
      }
      const baseline = this.#baselineOf(folder);
      this.#listings.set(folder, listing);
      if (baseline) events.push(...changesBetween(baseline, listing));
    });
    return { events, failed, listed: folders.length, refusals, lastRefusalSignInWontFix };
  }
}

function recordingUploads(transport: UploadTransport, notes: OwnChangeNotes): UploadTransport {
  const { chunked } = transport;
  const direct: UploadTransport['direct'] = async (path, file, opts) =>
    notes.noteOwnEntry(await transport.direct(path, file, opts));
  if (!chunked) return { direct };
  return {
    direct,
    chunked: {
      init: (path, totalBytes, opts) => chunked.init(path, totalBytes, opts),
      put: (uploadId, index, offset, data, signal) => chunked.put(uploadId, index, offset, data, signal),
      complete: async (uploadId) => notes.noteOwnEntry(await chunked.complete(uploadId)),
      abort: (uploadId) => chunked.abort(uploadId),
    },
  };
}

function recordingOwnChanges(adapter: FileSystemAdapter, notes: OwnChangeNotes): Partial<FileSystemAdapter> {
  const recorders: Partial<FileSystemAdapter> = {};
  if (adapter.create) {
    recorders.create = async (path, kind) => notes.noteOwnEntry(await adapter.create!(path, kind));
  }
  if (adapter.write) {
    recorders.write = async (path, text, opts) => notes.noteOwnEntry(await adapter.write!(path, text, opts));
  }
  if (adapter.copy) {
    recorders.copy = async (from, to, opts) => notes.noteOwnEntry(await adapter.copy!(from, to, opts));
  }
  if (adapter.move) {
    recorders.move = async (from, to, opts) => {
      const entry = await adapter.move!(from, to, opts);
      notes.noteOwnRemoval(from);
      return notes.noteOwnEntry(entry);
    };
  }
  if (adapter.delete) {
    recorders.delete = async (path) => {
      await adapter.delete!(path);
      notes.noteOwnRemoval(path);
    };
  }
  if (adapter.upload) recorders.upload = recordingUploads(adapter.upload, notes);
  return recorders;
}

function isPolledFolder(baselines: FolderBaselines, folder: string): boolean {
  try {
    return baselines.paths().includes(folder);
  } catch {
    return false;
  }
}

function listingsKeptAsBaselines(
  adapter: FileSystemAdapter,
  subscriptions: ReadonlySet<FolderBaselines>,
): FileSystemAdapter['list'] {
  return async (path, opts) => {
    const folder = normalizedOrUndefined(path);
    const seeds =
      folder === undefined
        ? []
        : [...subscriptions]
            .filter((baselines) => isPolledFolder(baselines, folder))
            .map((baselines) => baselines.keepTheAppsListingAsBaseline(folder));
    let entries: Entry[] | undefined;
    try {
      entries = await adapter.list(path, opts);
      return entries;
    } finally {
      for (const seed of seeds) seed(entries);
    }
  };
}

function denialTracker(options: PollingOptions): (round: PollRound) => boolean {
  const { rounds, onGiveUp } = options.giveUpWhenDenied ?? { rounds: Infinity, onGiveUp: () => undefined };
  let deniedRoundsInARow = 0;
  return (round) => {
    if (round.listed === 0) return false;
    if (round.refusals < round.listed) deniedRoundsInARow = 0;
    if (round.refusals < round.listed || !round.lastRefusalSignInWontFix) return false;
    deniedRoundsInARow++;
    if (deniedRoundsInARow < rounds) return false;
    onGiveUp(round.lastRefusalSignInWontFix);
    return true;
  };
}

function startPolling(
  adapter: FileSystemAdapter,
  baselines: FolderBaselines,
  options: PollingOptions,
  onChange: (events: ChangeEvent[]) => void,
): () => void {
  const { intervalMs = 3000, maxIntervalMs = 30000, maxFoldersPerRound = 50, isPaused } = options;
  const stopped = new AbortController();
  const list = (folder: string): Promise<Entry[]> =>
    adapter.list(folder, { depth: 1, signal: stopped.signal });
  let delayMs = intervalMs;
  let timer: Timer | undefined;
  let roundRunning = false;
  let lastRoundAt = -Infinity;
  const gaveUpAfter = denialTracker(options);
  let gaveUp = false;
  const runRound = async (): Promise<ChangeEvent[]> => {
    roundRunning = true;
    lastRoundAt = Date.now();
    let failed = true;
    try {
      const round = await baselines.poll([...new Set(options.paths())].slice(0, maxFoldersPerRound), list);
      failed = round.failed;
      gaveUp = gaveUpAfter(round);
      return round.events;
    } catch {
      return [];
    } finally {
      roundRunning = false;
      delayMs = failed ? Math.min(delayMs * 2, maxIntervalMs) : intervalMs;
    }
  };
  const pollNow = async (): Promise<void> => {
    clearTimeout(timer);
    if (roundRunning || gaveUp || stopped.signal.aborted) return;
    const events = isPaused?.() ? [] : await runRound();
    if (stopped.signal.aborted) return;
    if (!gaveUp) timer = setTimeout(pollNow, delayMs);
    if (events.length > 0) onChange(events);
  };
  const pollWhenDue = (): void => {
    if (roundRunning || gaveUp || stopped.signal.aborted) return;
    const remainingMs = lastRoundAt + delayMs - Date.now();
    if (remainingMs <= 0) return void pollNow();
    clearTimeout(timer);
    timer = setTimeout(pollNow, remainingMs);
  };
  const stopResumeSignal = options.resumeSignal?.(pollWhenDue);
  timer = setTimeout(pollNow, delayMs);
  return () => {
    stopped.abort();
    clearTimeout(timer);
    stopResumeSignal?.();
  };
}

function everySubscription(subscriptions: ReadonlySet<FolderBaselines>): OwnChangeNotes {
  return {
    noteOwnEntry: (entry) => {
      for (const baselines of subscriptions) baselines.noteOwnEntry(entry);
      return entry;
    },
    noteOwnRemoval: (path) => {
      for (const baselines of subscriptions) baselines.noteOwnRemoval(path);
    },
  };
}

/**
 * Adds `watch` to an adapter that has none by diffing depth-1 listings into ChangeEvents (actor
 * 'external'). Each subscription polls `options.paths()` every `intervalMs`: a polled folder's baseline is
 * the app's own first `list` of it through the returned adapter (its direct children), or else its first
 * poll, and later polls emit `created`, `deleted` and `updated` events that carry the entry, as one batch
 * per round. `updated` means a file's size or mtime changed; a folder's mtime only follows its children,
 * which are polled themselves. A move shows up as a delete plus a create.
 *
 * Changes made through the returned adapter (`create`, `write`, `move`, `copy`, `delete` and uploads) are
 * the user's own: once one succeeds, its result goes into every subscription's baselines, including a
 * listing in flight, so polling never reports it. A round in which a listing fails (or `paths` or `list`
 * throws) doubles the delay up to `maxIntervalMs`; a folder that cannot be listed (`not_found`, `invalid` or
 * `forbidden`) only loses its baseline. Rounds never overlap, nothing is polled while `isPaused()`, and the
 * unsubscribe stops the timer and aborts the listings in flight. `watch`'s `pollPaths` replaces `paths` for
 * that subscription. Every other member is the adapter's own,
 * bound to it.
 *
 * @example
 * ```ts
 * const live = withPolling(adapter, {
 *   paths: () => ['', ...expanded],
 *   isPaused: () => document.hidden,
 *   resumeSignal: (poll) => {
 *     const pollIfShown = () => !document.hidden && poll();
 *     document.addEventListener('visibilitychange', pollIfShown);
 *     return () => document.removeEventListener('visibilitychange', pollIfShown);
 *   },
 * });
 * ```
 */
export function withPolling(adapter: FileSystemAdapter, options: PollingOptions): FileSystemAdapter {
  const subscriptions = new Set<FolderBaselines>();
  const recorders = {
    ...recordingOwnChanges(adapter, everySubscription(subscriptions)),
    list: listingsKeptAsBaselines(adapter, subscriptions),
  };
  const watch = (onChange: (events: ChangeEvent[]) => void, watchOptions?: WatchOptions): (() => void) => {
    const paths = watchOptions?.pollPaths ?? options.paths;
    const baselines = new FolderBaselines(paths);
    subscriptions.add(baselines);
    const stopPolling = startPolling(adapter, baselines, { ...options, paths }, onChange);
    return () => {
      subscriptions.delete(baselines);
      stopPolling();
    };
  };
  const member = (property: string | symbol): unknown => {
    if (property === 'watch') return watch;
    if (Object.hasOwn(recorders, property)) return recorders[property as keyof FileSystemAdapter];
    const value: unknown = Reflect.get(adapter, property, adapter);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(adapter) : value;
  };
  const has = (property: string | symbol): boolean => property === 'watch' || Reflect.has(adapter, property);
  return new Proxy(Object.create(null) as FileSystemAdapter, {
    get: (_emptyTarget, property) => member(property),
    has: (_emptyTarget, property) => has(property),
    ownKeys: () => [...new Set([...Reflect.ownKeys(adapter), ...Reflect.ownKeys(recorders), 'watch'])],
    getOwnPropertyDescriptor: (_emptyTarget, property) =>
      has(property)
        ? { value: member(property), enumerable: true, configurable: true, writable: true }
        : undefined,
  });
}
