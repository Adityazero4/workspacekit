const PAGE_CACHE_CAPACITY = 8;
const RETAINED_BYTES_BUDGET = 512 * 1024 * 1024;

/**
 * Object URLs of rendered pages, least recently used first. `acquire` pins a page (a mounted page holds its
 * pin until `release`) and resolves to its URL, rendering it on a miss and sharing a pending render on a hit.
 * Renders run one at a time, in order; a queued render whose page was released before its turn is skipped
 * (it rejects). Past 8 pages, only unpinned pages are dropped; past `retainedBytesBudget` (512 MB) of
 * rendered PNGs, the least recently used pages are dropped even when pinned (an `<img>` that already shows
 * one keeps showing it; one still loading fails and should acquire again). Dropped URLs are revoked once
 * their renders settle. Eviction after a release waits a microtask, so StrictMode's release-then-acquire of
 * the same page keeps it. A failed render is not kept, so acquiring again retries. `clear` revokes every
 * URL.
 *
 * @example
 * ```ts
 * const cache = createPageCache(tiff.renderPage);
 * image.src = await cache.acquire(0);
 * cache.release(0);
 * ```
 */
export interface PageCache {
  acquire: (index: number) => Promise<string>;
  release: (index: number) => void;
  clear: () => void;
}

/**
 * Options for `createPageCache`; `retainedBytesBudget` defaults to 512 MB.
 *
 * @example
 * ```ts
 * const options: PageCacheOptions = { retainedBytesBudget: 64 * 1024 * 1024 };
 * ```
 */
export interface PageCacheOptions {
  retainedBytesBudget?: number;
}

const revokeWhenSettled = (entry: Promise<string>): void =>
  void entry.then(
    (url) => URL.revokeObjectURL(url),
    () => undefined,
  );

interface RetainedPages {
  entries: Map<number, Promise<string>>;
  retainedBytes: Map<number, number>;
  pins: Map<number, number>;
  evictPastLimits: (keep?: number) => void;
}

function createRetainedPages(budget: number): RetainedPages {
  const entries = new Map<number, Promise<string>>();
  const retainedBytes = new Map<number, number>();
  const pins = new Map<number, number>();
  const drop = (index: number, entry: Promise<string>): void => {
    entries.delete(index);
    retainedBytes.delete(index);
    revokeWhenSettled(entry);
  };
  const totalRetainedBytes = (): number =>
    [...retainedBytes.values()].reduce((total, bytes) => total + bytes, 0);
  const evictPastLimits = (keep?: number): void => {
    for (const [index, entry] of entries) {
      if (entries.size <= PAGE_CACHE_CAPACITY) break;
      if (!pins.has(index)) drop(index, entry);
    }
    for (const [index, entry] of entries) {
      if (totalRetainedBytes() <= budget) break;
      if (index !== keep) drop(index, entry);
    }
  };
  return { entries, retainedBytes, pins, evictPastLimits };
}

/**
 * Creates the {@link PageCache} for one parsed file, rendering pages with `renderPage`.
 *
 * @example
 * ```ts
 * const cache = createPageCache((index) => tiff.renderPage(index));
 * ```
 */
export function createPageCache(
  renderPage: (index: number) => Promise<Blob>,
  options: PageCacheOptions = {},
): PageCache {
  const pages = createRetainedPages(options.retainedBytesBudget ?? RETAINED_BYTES_BUDGET);
  const { entries, retainedBytes, pins, evictPastLimits } = pages;
  let renderQueue: Promise<unknown> = Promise.resolve();
  const render = (index: number): Promise<string> => {
    const entry: Promise<string> = renderQueue
      .then(() => {
        if (pins.has(index)) return renderPage(index);
        if (entries.get(index) === entry) entries.delete(index);
        throw new Error('This page was scrolled away before its turn to render');
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (entries.get(index) === entry) {
          retainedBytes.set(index, blob.size);
          evictPastLimits(index);
        }
        return url;
      });
    renderQueue = entry.catch(() => undefined);
    entry.catch(() => {
      if (entries.get(index) === entry) entries.delete(index);
    });
    return entry;
  };
  return {
    acquire: (index) => {
      pins.set(index, (pins.get(index) ?? 0) + 1);
      const entry = entries.get(index) ?? render(index);
      entries.delete(index);
      entries.set(index, entry);
      evictPastLimits(index);
      return entry;
    },
    release: (index) => {
      const count = pins.get(index) ?? 0;
      if (count > 1) pins.set(index, count - 1);
      else pins.delete(index);
      queueMicrotask(() => evictPastLimits());
    },
    clear: () => {
      for (const entry of entries.values()) revokeWhenSettled(entry);
      entries.clear();
      retainedBytes.clear();
      pins.clear();
    },
  };
}
