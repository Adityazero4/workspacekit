import { FsError, toFsError } from '../errors';
import { uniqueName, validateName } from '../naming';
import { basename, joinPath, normalizePath, parentPath, resolveUnder } from '../path';
import type { Entry, UploadTransport } from '../types';
import { createGate, mapWithConcurrency } from './pool';
import { withRetry } from './retry';

export type ConflictChoice = 'replace' | 'keepBoth' | 'skip';
/** `relativePath` includes the file name and is untrusted. */
export interface UploadItem {
  file: Blob & { name: string };
  relativePath: string;
}
export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  done: number;
  total: number;
  current?: string;
}
export interface UploadResult {
  uploaded: Entry[];
  skipped: string[];
  failed: { path: string; error: FsError }[];
  cancelled: boolean;
}
export interface UploaderOptions {
  transport: UploadTransport;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Default 3. */
  fileConcurrency?: number;
  /** Default 6, shared by every file in a run. */
  chunkConcurrency?: number;
  /** Files at or above this size are chunked (when the transport can). Default 1_048_576. */
  directThresholdBytes?: number;
  /** Default [1000, 3000, 9000, 15000]. */
  retryDelaysMs?: number[];
  /** Default [1000, 2000, 4000]. */
  chunkRetryDelaysMs?: number[];
}
export interface UploadOptions {
  /** Default 'keepBoth'. A function is asked once per conflicting path. */
  onConflict?: ConflictChoice | ((path: string) => Promise<ConflictChoice>);
  signal?: AbortSignal;
  onProgress?(p: UploadProgress): void;
}
export interface Uploader {
  upload(items: UploadItem[], targetDir: string, opts?: UploadOptions): Promise<UploadResult>;
}

/** The server picks the chunk size and the name search is open-ended, so both are capped. */
const MAX_CHUNKS = 100_000;
const MAX_NAME_CANDIDATES = 1000;

/** Validates every segment (the path is untrusted), then resolves it under `base`. */
function targetOf(base: string, rel: string): string {
  for (const seg of rel.split('/')) {
    if (validateName(seg, new Set()) !== null) throw new FsError('invalid', `invalid path: ${rel}`, { path: rel });
  }
  return resolveUnder(base, rel);
}

export function createUploader(o: UploaderOptions): Uploader {
  const {
    transport,
    exists,
    remove,
    fileConcurrency = 3,
    chunkConcurrency = 6,
    directThresholdBytes = 1_048_576,
    retryDelaysMs = [1000, 3000, 9000, 15000],
    chunkRetryDelaysMs = [1000, 2000, 4000],
  } = o;

  async function freePath(path: string, signal: AbortSignal): Promise<string> {
    const dir = parentPath(path);
    const name = basename(path);
    const taken = new Set([name]);
    for (let n = 0; n < MAX_NAME_CANDIDATES; n++) {
      if (signal.aborted) throw new FsError('cancelled');
      const candidate = uniqueName(name, taken);
      const p = joinPath(dir, candidate);
      if (!(await exists(p))) return p;
      taken.add(candidate);
    }
    throw new FsError('conflict', `no free name for ${path}`, { path });
  }

  return {
    async upload(items, targetDir, opts = {}) {
      const { onConflict = 'keepBoth', onProgress } = opts;
      const signal = opts.signal ?? new AbortController().signal;
      const base = normalizePath(targetDir);
      const total = items.length;
      const sizes = items.map((it) => it.file.size);
      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      const loaded = sizes.map(() => 0);
      let loadedBytes = 0;
      let done = 0;
      const report = (current: string): void =>
        onProgress?.({ loadedBytes, totalBytes, done, total, current });
      /** Progress per item only moves forward, so retries never make the total go back. */
      const setLoaded = (i: number, to: number, current: string): void => {
        const v = Math.min(to, sizes[i]!);
        if (v <= loaded[i]!) return;
        loadedBytes += v - loaded[i]!;
        loaded[i] = v;
        report(current);
      };
      const finish = (i: number, current: string): void => {
        done++;
        const rest = sizes[i]! - loaded[i]!;
        loaded[i] = sizes[i]!;
        loadedBytes += rest;
        report(current);
      };

      let uploaded: Entry[] = [];
      const skipped: string[] = [];
      const failed: UploadResult['failed'] = [];
      /** Paths that did not exist right before their upload started: the only ones cancel may delete. */
      const created = new Set<string>();
      const gate = createGate(chunkConcurrency);

      async function send(i: number, item: UploadItem, path: string, overwrite: boolean): Promise<Entry> {
        const { file } = item;
        const cur = item.relativePath;
        const chunked = transport.chunked;
        if (!chunked || file.size === 0 || file.size < directThresholdBytes) {
          return withRetry(
            () => transport.direct(path, file, { signal, overwrite, onProgress: (l) => setLoaded(i, l, cur) }),
            retryDelaysMs,
            signal,
          );
        }
        const { uploadId, chunkSize } = await withRetry(
          () => chunked.init(path, file.size, { overwrite }),
          retryDelaysMs,
          signal,
        );
        // Aborts this file's remaining chunks as soon as one fails for good, or the run is cancelled.
        const ctl = new AbortController();
        const stop = (): void => ctl.abort();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) ctl.abort(); // aborted while init was in flight: no chunk may start
        try {
          if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new FsError('invalid', `bad chunk size: ${chunkSize}`, { path });
          }
          const count = Math.ceil(file.size / chunkSize);
          if (count > MAX_CHUNKS) throw new FsError('invalid', `too many chunks: ${count}`, { path });
          const indexes = Array.from({ length: count }, (_, n) => n);
          const results = await mapWithConcurrency(
            indexes,
            chunkConcurrency,
            (n) =>
              gate(async () => {
                const offset = n * chunkSize;
                const data = file.slice(offset, Math.min(file.size, offset + chunkSize));
                try {
                  await withRetry(() => chunked.put(uploadId, n, offset, data, ctl.signal), chunkRetryDelaysMs, ctl.signal);
                } catch (e) {
                  ctl.abort();
                  throw e;
                }
                setLoaded(i, loaded[i]! + data.size, cur);
              }),
            ctl.signal,
          );
          // Every request has settled here. Prefer the real failure over the 'cancelled' it caused in its siblings.
          const errors = results.flatMap((r) => (r.status === 'rejected' ? [toFsError(r.reason)] : []));
          const real = errors.find((e) => e.kind !== 'cancelled') ?? errors[0];
          if (real) throw real;
          if (signal.aborted) throw new FsError('cancelled');
          return await chunked.complete(uploadId);
        } catch (e) {
          await chunked.abort(uploadId).catch(() => {}); // best effort
          throw e;
        } finally {
          signal.removeEventListener('abort', stop);
        }
      }

      async function run(item: UploadItem, i: number): Promise<void> {
        const cur = item.relativePath;
        let target = cur;
        let path = cur;
        try {
          target = targetOf(base, item.relativePath);
          path = target;
          let overwrite = false;
          if (await exists(path)) {
            const choice = typeof onConflict === 'function' ? await onConflict(path) : onConflict;
            if (choice === 'skip') {
              skipped.push(path);
              return finish(i, cur);
            }
            if (choice === 'keepBoth') path = await freePath(path, signal);
            else if (choice === 'replace') overwrite = true;
            else throw new FsError('invalid', 'unknown conflict choice', { path });
          }
          if (signal.aborted) return;
          // ponytail: cleanup removes created files only; parent folders made implicitly by the transport may remain.
          if (!overwrite) created.add(path);
          try {
            uploaded.push(await send(i, item, path, overwrite));
          } catch (e) {
            // Someone else created it after our exists() check: it is not ours to delete on cancel.
            if (toFsError(e).kind === 'conflict') created.delete(path);
            throw e;
          }
          finish(i, cur);
        } catch (e) {
          if (signal.aborted) return; // cancelled, not failed
          failed.push({ path: target, error: toFsError(e) });
          finish(i, cur);
        }
      }

      await mapWithConcurrency(items, fileConcurrency, run, signal);

      const cancelled = signal.aborted;
      if (cancelled) {
        // Every request has settled, so nothing can write after this point.
        const removed = new Set<string>();
        for (const p of created) {
          try {
            if (await exists(p)) {
              await remove(p);
              removed.add(p);
            }
          } catch {
            // best effort: leave whatever we could not delete
          }
        }
        uploaded = uploaded.filter((e) => !removed.has(e.path));
      }
      return { uploaded, skipped, failed, cancelled };
    },
  };
}
