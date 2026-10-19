import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChangeEvent } from '@scope/core';

/**
 * What `probe` learns about a path: `null` = gone, `undefined` = must not be reported.
 *
 * @example
 * const probe: Probe = exists ? { mtimeMs, birthMs } : null;
 */
export type Probe = { mtimeMs: number; birthMs: number } | null | undefined;

/**
 * What `createWatcher` watches and how it looks paths up.
 *
 * @example
 * const source: WatchSource = { root: '/srv/root', hiddenName: (name) => name === '.git', probe };
 */
export interface WatchSource {
  /** Directory to watch. */
  root: string;
  /** True for a single path segment that must never be reported (excluded names, temp files). */
  hiddenName(name: string): boolean;
  /** Looks the path up on disk. `osReportedName` is the name as the OS reported it (`rel` is NFC). */
  probe(rel: string, osReportedName: string): Promise<Probe>;
}

/**
 * Starts receiving change batches; returns the function that stops them.
 *
 * @example
 * const unsubscribe = subscribe((events) => send(events), (error) => close(error));
 */
export type Subscribe = (
  onChange: (events: ChangeEvent[]) => void,
  onError?: (e: unknown) => void,
) => () => void;

const QUIET_TIME_THAT_CLOSES_A_BATCH_MS = 50;
const LONGEST_BATCH_WAIT_MS = 500;
const PROBE_CONCURRENCY = 64;
const MAX_REMEMBERED_PATHS = 200_000;

interface Subscriber {
  onChange: (events: ChangeEvent[]) => void;
  onError?: (e: unknown) => void;
}

const pathExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

class RecursiveWatcher {
  readonly #source: WatchSource;
  readonly #rootName: string;
  readonly #subscribers = new Set<Subscriber>();
  readonly #reportedPaths = new Set<string>();
  #watcher: FSWatcher | undefined;
  #queued = new Map<string, string>();
  #startedAt = 0;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #batchOpenedAt = 0;
  #flushing = false;

  constructor(source: WatchSource) {
    this.#source = source;
    this.#rootName = basename(source.root).normalize('NFC');
  }

  subscribe: Subscribe = (onChange, onError) => {
    if (this.#subscribers.size === 0) this.#start();
    const subscriber: Subscriber = { onChange, onError };
    this.#subscribers.add(subscriber);
    return () => {
      if (this.#subscribers.delete(subscriber) && this.#subscribers.size === 0) this.#stop();
    };
  };

  #start(): void {
    this.#watcher = fsWatch(this.#source.root, { recursive: true, persistent: false }, (_type, filename) =>
      this.#queue(filename),
    );
    this.#watcher.on('error', (error) => this.#fail(error));
    this.#startedAt = Date.now();
  }

  #stop(): void {
    this.#generation++;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queued = new Map();
    this.#reportedPaths.clear();
    const watcher = this.#watcher;
    this.#watcher = undefined;
    watcher?.close();
  }

  #queue(filename: string | Buffer | null): void {
    if (filename === null) return;
    const osReportedName = filename.toString();
    const segments = osReportedName.split(/[\\/]/);
    const unreportable = segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        this.#source.hiddenName(segment.normalize('NFC')),
    );
    if (unreportable) return;
    this.#queued.set(segments.join('/').normalize('NFC'), osReportedName);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    const now = Date.now();
    if (this.#timer === undefined) this.#batchOpenedAt = now;
    clearTimeout(this.#timer);
    const untilLongestWait = this.#batchOpenedAt + LONGEST_BATCH_WAIT_MS - now;
    const delay = Math.max(0, Math.min(QUIET_TIME_THAT_CLOSES_A_BATCH_MS, untilLongestWait));
    this.#timer = setTimeout(() => void this.#flush(), delay);
  }

  async #isAboutTheVanishedWatchedRoot(rel: string): Promise<boolean> {
    return rel === this.#rootName && !(await pathExists(this.#source.root));
  }

  async #classify(rel: string, osReportedName: string, generation: number): Promise<ChangeEvent | undefined> {
    let probe: Probe;
    try {
      probe = await this.#source.probe(rel, osReportedName);
    } catch {
      return undefined;
    }
    if (probe === undefined) return undefined;
    if (probe === null) {
      if (await this.#isAboutTheVanishedWatchedRoot(rel)) return undefined;
      if (this.#generation === generation) this.#reportedPaths.delete(rel);
      return { type: 'deleted', path: rel };
    }
    const isNew = !this.#reportedPaths.has(rel) && probe.birthMs >= this.#startedAt;
    if (this.#generation === generation) {
      if (this.#reportedPaths.size >= MAX_REMEMBERED_PATHS) this.#reportedPaths.clear();
      this.#reportedPaths.add(rel);
    }
    return { type: isNew ? 'created' : 'updated', path: rel, mtimeMs: probe.mtimeMs };
  }

  async #classifyBatch(batch: [string, string][], generation: number): Promise<ChangeEvent[]> {
    const events: ChangeEvent[] = [];
    for (let at = 0; at < batch.length && this.#generation === generation; at += PROBE_CONCURRENCY) {
      const slice = batch.slice(at, at + PROBE_CONCURRENCY);
      const classified = await Promise.all(
        slice.map(([rel, osReportedName]) => this.#classify(rel, osReportedName, generation)),
      );
      for (const event of classified) if (event) events.push(event);
    }
    return events;
  }

  async #flush(): Promise<void> {
    this.#timer = undefined;
    if (this.#flushing) return;
    this.#flushing = true;
    const generation = this.#generation;
    const batch = [...this.#queued];
    this.#queued = new Map();
    let events: ChangeEvent[] = [];
    try {
      events = await this.#classifyBatch(batch, generation);
    } finally {
      this.#flushing = false;
    }
    const subscribersStayed = this.#generation === generation;
    if (subscribersStayed && events.length > 0) this.#notifyEach((subscriber) => subscriber.onChange(events));
    if (this.#queued.size > 0 && this.#subscribers.size > 0) this.#scheduleFlush();
  }

  #notifyEach(notify: (subscriber: Subscriber) => void): void {
    for (const subscriber of [...this.#subscribers]) {
      try {
        notify(subscriber);
      } catch {
        continue;
      }
    }
  }

  #fail(error: unknown): void {
    const subscribers = [...this.#subscribers];
    this.#subscribers.clear();
    this.#stop();
    for (const subscriber of subscribers) {
      try {
        subscriber.onError?.(error);
      } catch {
        continue;
      }
    }
  }
}

/**
 * One `fs.watch(root, { recursive: true })` shared by every subscriber: it starts with the first and closes
 * with the last. Changes are coalesced (50 ms of quiet, at most 500 ms), deduplicated by path and reported as
 * `deleted` (gone), `created` (never reported before and born after the watch began) or `updated`. Birth time
 * is that of the inode: an atomic write or editor save that replaces an old file gets a new one and reports
 * `created`; consumers treat `created` and `updated` alike. Up to 200,000 reported paths are remembered; past
 * that the memory is dropped and unknown paths fall back to their birth time. macOS reports the watched
 * directory itself under its own name, so a deletion under that name is reported only while the root still
 * exists (then it is a top-level entry of that name). Throws from `subscribe` when the OS watcher cannot
 * start.
 *
 * @example
 * const subscribe = createWatcher({ root, hiddenName, probe });
 * const stop = subscribe((events) => log(events));
 */
export function createWatcher(src: WatchSource): Subscribe {
  return new RecursiveWatcher(src).subscribe;
}

const ARRAY_BRACKETS_BYTES = 2;

/**
 * Largest JSON text of one SSE `data:` line; the client drops anything over 1 MiB.
 *
 * @example
 * if (json.length > MAX_FRAME_BYTES) splitFrame(json);
 */
export const MAX_FRAME_BYTES: number = 512 * 1024;

/**
 * Splits a batch into SSE frames (`data: <json>\n\n`), each below `MAX_FRAME_BYTES` of JSON, preserving
 * order.
 *
 * @example
 * for (const frame of toFrames(events)) controller.enqueue(encoder.encode(frame));
 */
export function toFrames(events: ChangeEvent[]): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let bytes = ARRAY_BRACKETS_BYTES;
  const flush = (): void => {
    if (parts.length > 0) out.push(`data: [${parts.join(',')}]\n\n`);
    parts = [];
    bytes = ARRAY_BRACKETS_BYTES;
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
