'use client';
import {
  basename,
  isSameOrDescendant,
  remapPrefix,
  type Entry,
  type FileSystemAdapter,
} from '@workspacekit/core';
import { mediaUrlOfBlob, safeUrlOrNull } from '../renderers/safeUrls';
import { viewerError, type RendererInput, type RendererSource, type ViewerError } from './registry';

interface SourceVersion {
  path: string;
  input: RendererInput;
  version: number | undefined;
  size: number | null | undefined;
}

/**
 * The content a viewer shows: the source of one version of the file at `path`, read for `input` from
 * `entry`. `objectUrl` is set when the loader created the URL and must revoke it. `movedTo` is the path the
 * file has moved to while the viewer may still be showing it at `path` (see `shownAt`). `identity` stays
 * the same across new versions and moves of the file, and changes only when another file replaces it.
 *
 * @example
 * ```ts
 * const visible = shownAt(shown, path)?.source;
 * ```
 */
export interface ShownSource extends SourceVersion {
  identity: number;
  entry: Entry;
  source: RendererSource;
  objectUrl: string | undefined;
  movedTo: string | undefined;
}

/**
 * What a {@link SourceLoader} holds: the source on screen, whether a newer one is loading, and why the
 * latest load failed.
 *
 * @example
 * ```ts
 * const { shown, loading, failure } = loader.getSnapshot();
 * ```
 */
export interface SourceLoaderState {
  shown: ShownSource | undefined;
  loading: boolean;
  failure: (SourceVersion & { error: ViewerError }) | undefined;
}

/**
 * The file version a viewer wants on screen. While `paused`, a source already shown for the path stays as
 * it is, whatever its version, and nothing is loaded for a path that shows nothing yet. When the entry's
 * size is unknown, a read that turns out larger than `maxBytes` (text by its UTF-8 bytes) is refused as
 * `too_large`.
 *
 * @example
 * ```ts
 * loader.sync(path, { adapter, entry, input: 'text', paused: false, maxBytes: undefined });
 * ```
 */
export interface SourceRequest {
  adapter: FileSystemAdapter;
  entry: Entry;
  input: RendererInput;
  paused: boolean;
  maxBytes: number | undefined;
}

interface InFlightRead {
  version: SourceVersion;
  controller: AbortController;
}

interface Loaded {
  source: RendererSource;
  objectUrl?: string;
}

class TooLargeToPreview extends Error {}

const NOTHING_SHOWN: SourceLoaderState = { shown: undefined, loading: false, failure: undefined };

const versionOf = (path: string, { entry, input }: SourceRequest): SourceVersion => ({
  path,
  input,
  version: entry.mtimeMs,
  size: entry.size,
});

const isSameVersion = (a: SourceVersion | undefined, b: SourceVersion): boolean =>
  a !== undefined && a.path === b.path && a.input === b.input && a.version === b.version && a.size === b.size;

const isSameSourceWithoutContent = (a: RendererSource, b: RendererSource): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'url' || (b.kind === 'url' && a.url === b.url && a.withCredentials === b.withCredentials));

/**
 * `shown` as the source for `path`: itself when it was loaded there, re-keyed when `path` is where it moved
 * to, `undefined` otherwise. A move is thus followed whenever the viewer's path follows it, before or after
 * the move is reported.
 *
 * @example
 * ```ts
 * const shownHere = shownAt(loader.getSnapshot().shown, path);
 * ```
 */
export function shownAt(shown: ShownSource | undefined, path: string): ShownSource | undefined {
  if (!shown || shown.path === path) return shown;
  if (shown.movedTo !== path) return undefined;
  return { ...shown, path, entry: { ...shown.entry, path, name: basename(path) }, movedTo: undefined };
}

/**
 * What `adapter.url` answers for `entry`, with both of its forms normalized; `undefined` when the adapter
 * has no `url` or no URL for this entry. The URL is not validated: see `adapterUrlSource`.
 *
 * @example
 * ```ts
 * const answer = adapterUrlOf(adapter, entry);
 * if (answer) downloadUrl(answer.url, entry.name);
 * ```
 */
export function adapterUrlOf(
  adapter: FileSystemAdapter,
  entry: Entry,
): { url: string; withCredentials: boolean } | undefined {
  const answer = adapter.url?.(entry);
  if (answer === undefined) return undefined;
  return typeof answer === 'string'
    ? { url: answer, withCredentials: false }
    : { url: answer.url, withCredentials: answer.withCredentials === true };
}

/**
 * The `url` source to stream `entry` from: the `adapter.url` answer when it is an http, https or blob URL,
 * `undefined` otherwise (no `url`, no answer, or a refused URL), in which case the file is read instead.
 *
 * @example
 * ```ts
 * const streams = adapterUrlSource(adapter, entry) !== undefined;
 * ```
 */
export function adapterUrlSource(adapter: FileSystemAdapter, entry: Entry): RendererSource | undefined {
  const answer = adapterUrlOf(adapter, entry);
  return answer && safeUrlOrNull(answer.url) !== null ? { kind: 'url', ...answer } : undefined;
}

function sourceWithoutReading({ adapter, entry, input }: SourceRequest): RendererSource | undefined {
  if (input === 'none') return { kind: 'none' };
  return input === 'url' ? adapterUrlSource(adapter, entry) : undefined;
}

function refuseOverLimit({ maxBytes }: SourceRequest, byteLength: () => number): void {
  if (maxBytes !== undefined && byteLength() > maxBytes) {
    throw new TooLargeToPreview();
  }
}

async function urlSourceFromBlob(request: SourceRequest, signal: AbortSignal): Promise<Loaded> {
  const blob = await request.adapter.read(request.entry.path, 'blob', { signal });
  signal.throwIfAborted();
  refuseOverLimit(request, () => blob.size);
  const { url, objectUrl } = await mediaUrlOfBlob(blob, request.entry.name, signal);
  return { source: { kind: 'url', url, withCredentials: false }, objectUrl };
}

async function readSource(request: SourceRequest, signal: AbortSignal): Promise<Loaded> {
  const { adapter, entry, input } = request;
  const options = { signal };
  switch (input) {
    case 'text': {
      const text = await adapter.read(entry.path, 'text', options);
      refuseOverLimit(request, () => new TextEncoder().encode(text).byteLength);
      return { source: { kind: 'text', text } };
    }
    case 'blob': {
      const blob = await adapter.read(entry.path, 'blob', options);
      refuseOverLimit(request, () => blob.size);
      return { source: { kind: 'blob', blob } };
    }
    case 'arrayBuffer': {
      const data = await adapter.read(entry.path, 'arrayBuffer', options);
      refuseOverLimit(request, () => data.byteLength);
      return { source: { kind: 'arrayBuffer', data } };
    }
    case 'none':
      return { source: { kind: 'none' } };
    case 'url':
      return urlSourceFromBlob(request, signal);
  }
}

const loadErrorOf = (error: unknown): ViewerError =>
  error instanceof TooLargeToPreview ? viewerError('too_large') : viewerError('load_error', error);

/**
 * Loads the source a viewer shows, one file version at a time. A newer request aborts the read in flight;
 * the source on screen stays until its replacement is ready. Object URLs are made from blobs typed so they
 * cannot render as a page: only inert `image/*`, `audio/*` and `video/*` keep their type, anything else
 * becomes `application/octet-stream`. An SVG (by type, or an untyped `.svg`) gets a `data:` URL instead,
 * whose opaque origin cannot act as the app. Object URLs are revoked once neither
 * the state nor the screen (see `showing`) holds them, and all of them on `dispose`. Every member is a
 * plain function, safe to pass unbound.
 *
 * @example
 * ```ts
 * const loader = new SourceLoader();
 * const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
 * ```
 */
export class SourceLoader {
  #state: SourceLoaderState = NOTHING_SHOWN;
  #listeners = new Set<() => void>();
  #inFlight: InFlightRead | undefined;
  #ownedObjectUrls = new Set<string>();
  #objectUrlOnScreen: string | undefined;
  #lastIdentity = 0;

  /** The current state; a new object after every change, for `useSyncExternalStore`. */
  getSnapshot = (): SourceLoaderState => this.#state;

  /** Calls `listener` after every state change. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * Brings the loader to `request` for `path`: forgets what belongs to another path, aborts the read in
   * flight when nothing is wanted, and otherwise loads the requested version unless it is shown, loading or
   * failed already, or paused (a paused path that shows nothing yet loads once it is no longer paused).
   * Calling it again with the same request changes nothing.
   */
  sync = (path: string, request: SourceRequest | undefined): void => {
    this.#forgetOtherPaths(path);
    if (!request) {
      this.#abort();
      return;
    }
    const version = versionOf(path, request);
    const { shown, failure } = this.#state;
    const shownForPath = shown?.path === path;
    if (request.paused && (!shownForPath || shown.input === request.input)) return;
    if (isSameVersion(failure, version)) return;
    const immediate = sourceWithoutReading(request);
    if (immediate) this.#showWithoutReading(version, request, immediate);
    else if (!isSameVersion(shown, version) && !isSameVersion(this.#inFlight?.version, version)) {
      this.#startReading(version, request);
    }
  };

  /**
   * Records that the shown file moved (`onMovedPaths`), so the source stays on screen at its old path and is
   * re-keyed once the viewer's path follows the move, in whichever order the two happen.
   */
  followMove = (from: string, to: string): void => {
    const { shown } = this.#state;
    if (from === to || !shown) return;
    const current = shown.movedTo ?? shown.path;
    if (!isSameOrDescendant(current, from)) return;
    const movedTo = remapPrefix(current, from, to);
    this.#update({ shown: { ...shown, movedTo: movedTo === shown.path ? undefined : movedTo } });
  };

  /** Forgets the latest failure, so the next `sync` tries that version again. */
  retry = (): void => {
    if (this.#state.failure) this.#update({ failure: undefined });
  };

  /** Records the object URL that is on screen now; call it once a render using it is committed. */
  showing = (objectUrl: string | undefined): void => {
    this.#objectUrlOnScreen = objectUrl;
    this.#revokeUnusedObjectUrls();
  };

  /** Aborts the read in flight, revokes every object URL and starts over with nothing shown. */
  dispose = (): void => {
    this.#abort();
    this.#objectUrlOnScreen = undefined;
    this.#state = NOTHING_SHOWN;
    this.#revokeUnusedObjectUrls();
    this.#notify();
  };

  #forgetOtherPaths(path: string): void {
    if (this.#inFlight && this.#inFlight.version.path !== path) this.#abort();
    const { shown, failure } = this.#state;
    const shownHere = shownAt(shown, path);
    if (shownHere !== shown) this.#update({ shown: shownHere });
    if (failure && failure.path !== path) this.#update({ failure: undefined });
  }

  #showWithoutReading(version: SourceVersion, request: SourceRequest, source: RendererSource): void {
    this.#abort();
    const { shown } = this.#state;
    const keptSource =
      shown?.path === version.path && isSameSourceWithoutContent(shown.source, source)
        ? shown.source
        : undefined;
    if (keptSource && isSameVersion(shown, version)) return;
    this.#update({
      shown: {
        ...version,
        identity: this.#identityFor(version.path),
        entry: request.entry,
        source: keptSource ?? source,
        objectUrl: undefined,
        movedTo: shown?.path === version.path ? shown.movedTo : undefined,
      },
      failure: undefined,
    });
  }

  #startReading(version: SourceVersion, request: SourceRequest): void {
    this.#abort();
    const inFlight = { version, controller: new AbortController() };
    this.#inFlight = inFlight;
    this.#update({ failure: undefined });
    readSource(request, inFlight.controller.signal).then(
      (loaded) => {
        if (!this.#settle(inFlight)) {
          if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
          return;
        }
        if (loaded.objectUrl) this.#ownedObjectUrls.add(loaded.objectUrl);
        const { shown } = this.#state;
        const movedTo = shown?.path === inFlight.version.path ? shown.movedTo : undefined;
        const loadedShown = {
          ...inFlight.version,
          identity: this.#identityFor(inFlight.version.path),
          entry: request.entry,
          objectUrl: undefined,
          movedTo,
          ...loaded,
        };
        this.#update({ shown: loadedShown, failure: undefined });
      },
      (error: unknown) => {
        if (this.#settle(inFlight)) {
          this.#update({ failure: { ...inFlight.version, error: loadErrorOf(error) } });
        }
      },
    );
  }

  #identityFor(path: string): number {
    const { shown } = this.#state;
    return shown?.path === path ? shown.identity : ++this.#lastIdentity;
  }

  #settle(inFlight: InFlightRead): boolean {
    if (this.#inFlight !== inFlight) return false;
    this.#inFlight = undefined;
    return true;
  }

  #abort(): void {
    if (!this.#inFlight) return;
    this.#inFlight.controller.abort();
    this.#inFlight = undefined;
    this.#update({});
  }

  #update(changes: Partial<SourceLoaderState>): void {
    const next = { ...this.#state, ...changes, loading: this.#inFlight !== undefined };
    const previous = this.#state;
    if (
      next.shown === previous.shown &&
      next.loading === previous.loading &&
      next.failure === previous.failure
    ) {
      return;
    }
    this.#state = next;
    if (next.shown !== previous.shown) this.#revokeUnusedObjectUrls();
    this.#notify();
  }

  #revokeUnusedObjectUrls(): void {
    for (const url of this.#ownedObjectUrls) {
      if (url === this.#objectUrlOnScreen || url === this.#state.shown?.objectUrl) continue;
      URL.revokeObjectURL(url);
      this.#ownedObjectUrls.delete(url);
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
