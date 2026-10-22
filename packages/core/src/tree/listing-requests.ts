import { isSameOrDescendant } from '../path';

interface CoalescingListing {
  requestId: number;
  trailingReloadDue: boolean;
}

/**
 * Every folder listing a `TreeStore` has asked the adapter for, keyed by folder path. Each request gets an
 * increasing id, and a folder's in-flight id, the caller's interest in it, its load promise and its
 * coalescing state are kept and discarded together. A listing that was re-issued coalesces: further changes
 * during its flight queue one trailing reload instead of re-issuing it again.
 *
 * @example
 * ```ts
 * const listings = new ListingRequests();
 * const requestId = listings.begin('docs', true);
 * const entries = await adapter.list('docs');
 * if (listings.isCurrent('docs', requestId)) apply(entries);
 * listings.end('docs', requestId);
 * ```
 */
export class ListingRequests {
  readonly #inFlightRequestId = new Map<string, number>();
  readonly #latestRequestId = new Map<string, number>();
  readonly #requestedByCaller = new Set<string>();
  readonly #inFlightLoads = new Map<string, Promise<void>>();
  readonly #coalescingListings = new Map<string, CoalescingListing>();
  readonly #trailingReloads = new WeakSet<Promise<void>>();
  #lastRequestId = 0;

  /** Starts a listing request of `path`, replacing any in flight, and returns its id. */
  begin(path: string, explicit: boolean): number {
    const requestId = ++this.#lastRequestId;
    this.#inFlightRequestId.set(path, requestId);
    this.#latestRequestId.set(path, requestId);
    this.#coalescingListings.delete(path);
    if (explicit) this.#requestedByCaller.add(path);
    return requestId;
  }

  /** Whether `requestId` is still the in-flight request of `path`, so its answer may be applied. */
  isCurrent(path: string, requestId: number): boolean {
    return this.#inFlightRequestId.get(path) === requestId;
  }

  /** Ends the request once it has settled, unless a newer request of `path` replaced it. */
  end(path: string, requestId: number): void {
    if (this.#inFlightRequestId.get(path) !== requestId) return;
    this.#inFlightRequestId.delete(path);
    this.#requestedByCaller.delete(path);
  }

  /** Whether a listing request of `path` is in flight. */
  isInFlight(path: string): boolean {
    return this.#inFlightRequestId.has(path);
  }

  /**
   * A live view of the folders with a request in flight, not a copy: a folder discarded during iteration is
   * not visited afterwards.
   */
  liveInFlightPaths(): Iterable<string> {
    return this.#inFlightRequestId.keys();
  }

  /** Whether a caller asked for the in-flight request of `path`, rather than the store in the background. */
  isRequestedByCaller(path: string): boolean {
    return this.#requestedByCaller.has(path);
  }

  /** The in-flight requests a caller asked for at or below `path`. */
  callerRequestsAtOrBelow(path: string): string[] {
    return [...this.#requestedByCaller].filter((requested) => isSameOrDescendant(requested, path));
  }

  /** Whether every request of `path` so far started before `requestId`. */
  lastRequestedBefore(path: string, requestId: number): boolean {
    return (this.#latestRequestId.get(path) ?? 0) < requestId;
  }

  /** Forgets the requests in flight at or below `path`, so their answers are dropped; returns their paths. */
  discardAtOrBelow(path: string): string[] {
    const discarded: string[] = [];
    for (const loading of this.#inFlightRequestId.keys()) {
      if (!isSameOrDescendant(loading, path)) continue;
      this.#inFlightRequestId.delete(loading);
      this.#inFlightLoads.delete(loading);
      this.#requestedByCaller.delete(loading);
      this.#coalescingListings.delete(loading);
      discarded.push(loading);
    }
    return discarded;
  }

  /**
   * The load of `path` that is running, if any. An `explicit` caller joining it makes its in-flight request
   * one the caller asked for.
   */
  joinRunningLoad(path: string, explicit: boolean): Promise<void> | undefined {
    const running = this.#inFlightLoads.get(path);
    if (running && explicit && this.#inFlightRequestId.has(path)) this.#requestedByCaller.add(path);
    return running;
  }

  /** Records `load` as the running load of `path` until it settles, and returns it. */
  trackLoad(path: string, load: Promise<void>): Promise<void> {
    const run: Promise<void> = load.finally(() => {
      if (this.#inFlightLoads.get(path) === run) this.#inFlightLoads.delete(path);
    });
    this.#inFlightLoads.set(path, run);
    return run;
  }

  /** The running load of `path` a caller should wait for next; never a trailing reload. */
  loadToWaitFor(path: string): Promise<void> | undefined {
    const newer = this.#inFlightLoads.get(path);
    return newer === undefined || this.#trailingReloads.has(newer) ? undefined : newer;
  }

  /**
   * Decides whether the listing of `folder` in flight needs a re-issue; sends nothing. A re-issued listing
   * still in flight only gets a trailing reload marked due, and the answer is `undefined`, as it is when
   * nothing is in flight. Otherwise the answer says who asked for the listing, so the caller re-issues it the
   * same way.
   */
  markReissue(folder: string): 'caller' | 'background' | undefined {
    const inFlight = this.#inFlightRequestId.get(folder);
    if (inFlight === undefined) return undefined;
    const coalescing = this.#coalescingListings.get(folder);
    if (coalescing?.requestId === inFlight) {
      coalescing.trailingReloadDue = true;
      return undefined;
    }
    return this.#requestedByCaller.has(folder) ? 'caller' : 'background';
  }

  /**
   * Runs `startReissues`, then makes the requests it started for the `reissued` folders coalesce further
   * changes into one trailing reload.
   */
  coalesceReissues(reissued: Iterable<string>, startReissues: () => void): void {
    const firstReissueId = this.#lastRequestId + 1;
    startReissues();
    for (const path of reissued) {
      const requestId = this.#inFlightRequestId.get(path);
      if (requestId !== undefined && requestId >= firstReissueId) this.#coalesce(path, requestId);
    }
  }

  /**
   * Ends the coalescing of `path` once its request `requestId` has settled, and returns whether changes
   * during that flight left a trailing reload due.
   */
  takeDueTrailingReload(path: string, requestId: number): boolean {
    const coalescing = this.#coalescingListings.get(path);
    if (coalescing?.requestId !== requestId) return false;
    this.#coalescingListings.delete(path);
    return coalescing.trailingReloadDue;
  }

  /**
   * Records `reload` as the trailing reload of `path`, which callers do not wait for, and makes its request
   * coalesce further changes too.
   */
  coalesceTrailingReload(path: string, reload: Promise<void>): void {
    this.#trailingReloads.add(reload);
    const trailingRequestId = this.#inFlightRequestId.get(path);
    if (trailingRequestId === undefined) return;
    this.#coalesce(path, trailingRequestId);
  }

  #coalesce(path: string, requestId: number): void {
    this.#coalescingListings.set(path, { requestId, trailingReloadDue: false });
  }
}
