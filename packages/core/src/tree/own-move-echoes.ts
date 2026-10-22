const ECHO_WINDOW_MS = 10_000;

/**
 * One of the store's own moves while its watch echo is expected: a read-only handle for `OwnMoveEchoes`,
 * whose methods are the only ones to change it.
 *
 * @example
 * ```ts
 * const own: OwnMove = echoes.expect('a.txt', 'docs/a.txt');
 * ```
 */
export interface OwnMove {
  readonly from: string;
  readonly to: string;
  readonly inFlight: boolean;
  readonly consumedWhileInFlight: readonly string[];
  readonly expiry?: ReturnType<typeof setTimeout>;
}

interface TrackedOwnMove {
  readonly from: string;
  to: string;
  inFlight: boolean;
  consumedWhileInFlight: string[];
  expiry?: ReturnType<typeof setTimeout>;
}

const tracked = (own: OwnMove): TrackedOwnMove => own as TrackedOwnMove;

/**
 * The store's own moves whose watch echo has not arrived yet, so that echo is not announced as a second
 * move. While a move runs, the first `moved` event from its source is its echo, to any path, since the server
 * may pick the name; after it settles, the first one with its old and final path, for 10 s. Each move
 * expects one echo, and a move that fails hands back the events it took for its echo.
 *
 * @example
 * ```ts
 * const own = echoes.expect('a.txt', 'docs/a.txt');
 * echoes.consume('a.txt', 'docs/a.txt');
 * echoes.stopAwaitingSoon(own);
 * ```
 */
export class OwnMoveEchoes {
  readonly #awaitingEcho = new Set<TrackedOwnMove>();

  /** Starts expecting the echo of a move from `from` to `to` that is about to run. */
  expect(from: string, to: string): OwnMove {
    const own: TrackedOwnMove = { from, to, inFlight: true, consumedWhileInFlight: [] };
    this.#awaitingEcho.add(own);
    return own;
  }

  /** Records the path the move ended at, which its echo must name once the move has settled. */
  landedAt(own: OwnMove, to: string): void {
    tracked(own).to = to;
  }

  /** Marks the move settled; an echo not yet seen is still expected for 10 s. */
  stopAwaitingSoon(handle: OwnMove): void {
    const own = tracked(handle);
    own.inFlight = false;
    if (!this.#awaitingEcho.has(own)) return;
    own.expiry = setTimeout(() => this.#awaitingEcho.delete(own), ECHO_WINDOW_MS);
  }

  /** Stops expecting the echo of a move that failed and returns the paths of the moves taken for its echo. */
  stopAwaitingFailed(handle: OwnMove): string[] {
    const own = tracked(handle);
    this.#awaitingEcho.delete(own);
    return own.consumedWhileInFlight.splice(0);
  }

  /** Whether a `moved` event from `from` to `to` is an own move's echo; that move stops expecting one. */
  consume(from: string, to: string): boolean {
    for (const own of this.#awaitingEcho) {
      if (own.from !== from || (!own.inFlight && own.to !== to)) continue;
      if (own.inFlight) own.consumedWhileInFlight.push(to);
      clearTimeout(own.expiry);
      this.#awaitingEcho.delete(own);
      return true;
    }
    return false;
  }

  /** Stops expecting every echo and cancels their timers. */
  dispose(): void {
    for (const own of this.#awaitingEcho) clearTimeout(own.expiry);
    this.#awaitingEcho.clear();
  }
}
