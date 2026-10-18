import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChangeEvent } from '@scope/core';

/** What `probe` learns about a path: `null` = gone, `undefined` = must not be reported. */
export type Probe = { mtimeMs: number; birthMs: number } | null | undefined;

export interface WatchSource {
  /** Directory to watch. */
  root: string;
  /** True for a single path segment that must never be reported (excluded names, temp files). */
  hiddenName(name: string): boolean;
  /** Looks the path up on disk. `raw` is the name as the OS reported it (`rel` is NFC). */
  probe(rel: string, raw: string): Promise<Probe>;
}

export type Subscribe = (onChange: (events: ChangeEvent[]) => void, onError?: (e: unknown) => void) => () => void;

/** Quiet time that closes a batch, and the longest a batch may stay open under a steady stream of changes. */
const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 500;
const PROBE_CONCURRENCY = 64;
/** Beyond this many remembered paths the memory is dropped; unknown paths fall back to their birth time. */
const MAX_SEEN = 200_000;

/**
 * One `fs.watch(root, { recursive: true })` shared by every subscriber: it starts with the first and
 * closes with the last. Changes are coalesced (50 ms of quiet, at most 500 ms), deduplicated by path
 * and reported as `deleted` (gone), `created` (never reported before and born after the watch began)
 * or `updated`. Birth time is that of the inode: an atomic write or editor save that replaces an old
 * file gets a new one and reports `created`; consumers treat `created` and `updated` alike. Throws from `subscribe` when the OS watcher cannot start.
 */
export function createWatcher(src: WatchSource): Subscribe {
  const subs = new Set<{ cb: (e: ChangeEvent[]) => void; onError?: (e: unknown) => void }>();
  let watcher: FSWatcher | undefined;
  let pending = new Map<string, string>();
  const seen = new Set<string>();
  let startedAt = 0;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;
  let busy = false;
  const rootName = basename(src.root).normalize('NFC');

  function stop(): void {
    epoch++;
    clearTimeout(timer);
    timer = undefined;
    pending = new Map();
    seen.clear();
    const w = watcher;
    watcher = undefined;
    w?.close();
  }

  function schedule(): void {
    const now = Date.now();
    if (timer === undefined) firstAt = now;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - now)));
  }

  function onFsEvent(_type: string, filename: string | Buffer | null): void {
    if (filename === null) return;
    const raw = filename.toString();
    const segs = raw.split(/[\\/]/);
    if (segs.some((s) => s === '' || s === '.' || s === '..' || src.hiddenName(s.normalize('NFC')))) return;
    pending.set(segs.join('/').normalize('NFC'), raw);
    schedule();
  }

  async function classify(rel: string, raw: string, mine: number): Promise<ChangeEvent | undefined> {
    let p: Probe;
    try {
      p = await src.probe(rel, raw);
    } catch {
      return undefined;
    }
    if (p === undefined) return undefined;
    if (p === null) {
      // macOS reports the watched directory itself under its own name: only a vanished root is "deleted"
      if (rel === rootName && !(await stat(src.root).then(() => true, () => false))) return undefined;
      if (epoch === mine) seen.delete(rel);
      return { type: 'deleted', path: rel };
    }
    const fresh = !seen.has(rel) && p.birthMs >= startedAt;
    if (epoch === mine) {
      if (seen.size >= MAX_SEEN) seen.clear();
      seen.add(rel);
    }
    return { type: fresh ? 'created' : 'updated', path: rel, mtimeMs: p.mtimeMs };
  }

  async function flush(): Promise<void> {
    timer = undefined;
    if (busy) return; // the running flush reschedules when it ends
    busy = true;
    const mine = epoch;
    const batch = [...pending];
    pending = new Map();
    const events: ChangeEvent[] = [];
    try {
      for (let i = 0; i < batch.length && epoch === mine; i += PROBE_CONCURRENCY) {
        const got = await Promise.all(batch.slice(i, i + PROBE_CONCURRENCY).map(([rel, raw]) => classify(rel, raw, mine)));
        for (const e of got) if (e) events.push(e);
      }
    } finally {
      busy = false;
    }
    // Everybody may have left meanwhile (drop the events), but whatever queued since still needs its flush.
    if (epoch === mine && events.length > 0) {
      for (const s of [...subs]) {
        try {
          s.cb(events);
        } catch {
          // one broken subscriber must not starve the others
        }
      }
    }
    if (pending.size > 0 && subs.size > 0) schedule();
  }

  function fail(e: unknown): void {
    const all = [...subs];
    subs.clear();
    stop();
    for (const s of all) {
      try {
        s.onError?.(e);
      } catch {
        // ignore
      }
    }
  }

  return (cb, onError) => {
    if (subs.size === 0) {
      watcher = fsWatch(src.root, { recursive: true, persistent: false }, onFsEvent);
      watcher.on('error', fail);
      startedAt = Date.now();
    }
    const sub = { cb, onError };
    subs.add(sub);
    return () => {
      if (subs.delete(sub) && subs.size === 0) stop();
    };
  };
}

/** Largest JSON text of one SSE `data:` line; the client drops anything over 1 MiB. */
export const MAX_FRAME_BYTES: number = 512 * 1024;

/** Splits a batch into SSE frames (`data: <json>\n\n`), each below `MAX_FRAME_BYTES` of JSON, preserving order. */
export function toFrames(events: ChangeEvent[]): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let bytes = 2; // the brackets
  const flush = (): void => {
    if (parts.length > 0) out.push(`data: [${parts.join(',')}]\n\n`);
    parts = [];
    bytes = 2;
  };
  for (const e of events) {
    const json = JSON.stringify(e);
    const n = Buffer.byteLength(json) + 1;
    if (bytes + n >= MAX_FRAME_BYTES) flush();
    parts.push(json);
    bytes += n;
  }
  flush();
  return out;
}
