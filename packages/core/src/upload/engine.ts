import { FsError, toFsError } from '../errors';
import { uniqueName, validateName } from '../naming';
import { basename, joinPath, normalizePath, parentPath, resolveUnder } from '../path';
import type { Entry, UploadTransport } from '../types';
import { createGate, mapWithConcurrency } from './pool';
import { withRetry } from './retry';

/**
 * What to do when an upload's target already exists.
 *
 * @example
 * ```ts
 * const onConflict = (path: string): Promise<ConflictChoice> => askUser(path);
 * ```
 */
export type ConflictChoice = 'replace' | 'keepBoth' | 'skip';
/**
 * `relativePath` includes the file name and is untrusted.
 *
 * @example
 * ```ts
 * const item: UploadItem = { file, relativePath: 'photos/cat.png' };
 * ```
 */
export interface UploadItem {
  file: Blob & { name: string };
  relativePath: string;
}
/**
 * Progress of an upload run, reported after every change.
 *
 * @example
 * ```ts
 * onProgress: ({ loadedBytes, totalBytes }) => setPercent((100 * loadedBytes) / totalBytes)
 * ```
 */
export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  done: number;
  total: number;
  current?: string;
}
/**
 * The outcome of an upload run, per file.
 *
 * @example
 * ```ts
 * if (result.failed.length > 0) notify(`${result.failed.length} uploads failed`);
 * ```
 */
export interface UploadResult {
  uploaded: Entry[];
  skipped: string[];
  failed: { path: string; error: FsError }[];
  cancelled: boolean;
}
/**
 * How an uploader sends files and checks for existing ones.
 *
 * @example
 * ```ts
 * const options: UploaderOptions = { transport: adapter.upload!, exists, remove, fileConcurrency: 2 };
 * ```
 */
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
/**
 * Options for one `upload` run.
 *
 * @example
 * ```ts
 * await uploader.upload(items, 'inbox', { onConflict: 'replace', signal: controller.signal });
 * ```
 */
export interface UploadOptions {
  /** Default 'keepBoth'. A function is asked once per conflicting path. */
  onConflict?: ConflictChoice | ((path: string) => Promise<ConflictChoice>);
  signal?: AbortSignal;
  onProgress?(p: UploadProgress): void;
}
/**
 * Uploads files and folders, created by `createUploader`.
 *
 * @example
 * ```ts
 * const result = await uploader.upload(items, 'inbox');
 * ```
 */
export interface Uploader {
  upload(items: UploadItem[], targetDir: string, opts?: UploadOptions): Promise<UploadResult>;
}

const MAX_CHUNKS_PER_FILE = 100_000;
const MAX_FREE_NAME_ATTEMPTS = 1000;
const ignoreError = (): void => undefined;

type ResolvedUploaderOptions = Required<UploaderOptions>;

function withDefaults(options: UploaderOptions): ResolvedUploaderOptions {
  return {
    ...options,
    fileConcurrency: options.fileConcurrency ?? 3,
    chunkConcurrency: options.chunkConcurrency ?? 6,
    directThresholdBytes: options.directThresholdBytes ?? 1_048_576,
    retryDelaysMs: options.retryDelaysMs ?? [1000, 3000, 9000, 15000],
    chunkRetryDelaysMs: options.chunkRetryDelaysMs ?? [1000, 2000, 4000],
  };
}

function validatedTarget(base: string, relativePath: string): string {
  for (const segment of relativePath.split('/')) {
    if (validateName(segment, new Set()) !== null) {
      throw new FsError('invalid', `invalid path: ${relativePath}`, { path: relativePath });
    }
  }
  return resolveUnder(base, relativePath);
}

async function findFreePath(
  path: string,
  signal: AbortSignal,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const dir = parentPath(path);
  const name = basename(path);
  const taken = new Set([name]);
  for (let attempt = 0; attempt < MAX_FREE_NAME_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new FsError('cancelled');
    const candidate = uniqueName(name, taken);
    const candidatePath = joinPath(dir, candidate);
    if (!(await exists(candidatePath))) return candidatePath;
    taken.add(candidate);
  }
  throw new FsError('conflict', `no free name for ${path}`, { path });
}

function validatedChunkCount(fileSize: number, chunkSize: number, path: string): number {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new FsError('invalid', `bad chunk size: ${chunkSize}`, { path });
  }
  const count = Math.ceil(fileSize / chunkSize);
  if (count > MAX_CHUNKS_PER_FILE) throw new FsError('invalid', `too many chunks: ${count}`, { path });
  return count;
}

function failureOverItsCancellations(results: PromiseSettledResult<unknown>[]): FsError | undefined {
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [toFsError(result.reason)] : [],
  );
  return errors.find((error) => error.kind !== 'cancelled') ?? errors[0];
}

type Destination = { path: string; overwrite: boolean } | 'skip';
type ChunkedTransport = NonNullable<UploadTransport['chunked']>;

interface ChunkedFileUpload {
  transport: ChunkedTransport;
  uploadId: string;
  chunkSize: number;
  item: UploadItem;
  itemIndex: number;
  abortRemainingChunks: AbortController;
}

class UploadRun {
  readonly #options: ResolvedUploaderOptions;
  readonly #base: string;
  readonly #signal: AbortSignal;
  readonly #onConflict: NonNullable<UploadOptions['onConflict']>;
  readonly #uploadOptions: UploadOptions;
  readonly #sizes: number[];
  readonly #loaded: number[];
  readonly #totalBytes: number;
  #loadedBytes = 0;
  #done = 0;
  #uploaded: Entry[] = [];
  readonly #skipped: string[] = [];
  readonly #failed: UploadResult['failed'] = [];
  readonly #createdByThisRun = new Set<string>();
  readonly #chunkSlots: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    options: ResolvedUploaderOptions,
    base: string,
    items: UploadItem[],
    uploadOptions: UploadOptions,
  ) {
    this.#options = options;
    this.#base = base;
    this.#signal = uploadOptions.signal ?? new AbortController().signal;
    this.#onConflict = uploadOptions.onConflict ?? 'keepBoth';
    this.#uploadOptions = uploadOptions;
    this.#sizes = items.map((item) => item.file.size);
    this.#loaded = this.#sizes.map(() => 0);
    this.#totalBytes = this.#sizes.reduce((sum, size) => sum + size, 0);
    this.#chunkSlots = createGate(options.chunkConcurrency);
  }

  async execute(items: UploadItem[]): Promise<UploadResult> {
    await mapWithConcurrency(
      items,
      this.#options.fileConcurrency,
      (item, index) => this.#uploadItem(item, index),
      this.#signal,
    );
    const cancelled = this.#signal.aborted;
    if (cancelled) await this.#removeFilesCreatedByThisRun();
    return { uploaded: this.#uploaded, skipped: this.#skipped, failed: this.#failed, cancelled };
  }

  #report(current: string): void {
    this.#uploadOptions.onProgress?.({
      loadedBytes: this.#loadedBytes,
      totalBytes: this.#totalBytes,
      done: this.#done,
      total: this.#sizes.length,
      current,
    });
  }

  #advanceProgress(itemIndex: number, loaded: number, current: string): void {
    const clamped = Math.min(loaded, this.#sizes[itemIndex]!);
    if (clamped <= this.#loaded[itemIndex]!) return;
    this.#loadedBytes += clamped - this.#loaded[itemIndex]!;
    this.#loaded[itemIndex] = clamped;
    this.#report(current);
  }

  #completeItem(itemIndex: number, current: string): void {
    this.#done++;
    this.#loadedBytes += this.#sizes[itemIndex]! - this.#loaded[itemIndex]!;
    this.#loaded[itemIndex] = this.#sizes[itemIndex]!;
    this.#report(current);
  }

  async #uploadItem(item: UploadItem, itemIndex: number): Promise<void> {
    const label = item.relativePath;
    let target = label;
    try {
      target = validatedTarget(this.#base, item.relativePath);
      const destination = await this.#resolveConflict(target);
      if (destination === 'skip') {
        this.#skipped.push(target);
        return this.#completeItem(itemIndex, label);
      }
      if (this.#signal.aborted) return;
      this.#uploaded.push(await this.#sendRecordingCreation(itemIndex, item, destination));
      this.#completeItem(itemIndex, label);
    } catch (error) {
      if (this.#signal.aborted) return;
      this.#failed.push({ path: target, error: toFsError(error) });
      this.#completeItem(itemIndex, label);
    }
  }

  async #resolveConflict(path: string): Promise<Destination> {
    if (!(await this.#options.exists(path))) return { path, overwrite: false };
    const choice = typeof this.#onConflict === 'function' ? await this.#onConflict(path) : this.#onConflict;
    switch (choice) {
      case 'skip':
        return 'skip';
      case 'keepBoth':
        return {
          path: await findFreePath(path, this.#signal, (candidate) => this.#options.exists(candidate)),
          overwrite: false,
        };
      case 'replace':
        return { path, overwrite: true };
      default:
        throw new FsError('invalid', 'unknown conflict choice', { path });
    }
  }

  async #sendRecordingCreation(
    itemIndex: number,
    item: UploadItem,
    { path, overwrite }: Exclude<Destination, 'skip'>,
  ): Promise<Entry> {
    if (!overwrite) this.#createdByThisRun.add(path);
    try {
      return await this.#send(itemIndex, item, path, overwrite);
    } catch (error) {
      const createdByOthersSinceTheExistsCheck = toFsError(error).kind === 'conflict';
      if (createdByOthersSinceTheExistsCheck) this.#createdByThisRun.delete(path);
      throw error;
    }
  }

  #send(itemIndex: number, item: UploadItem, path: string, overwrite: boolean): Promise<Entry> {
    const { transport, directThresholdBytes, retryDelaysMs } = this.#options;
    const { file } = item;
    const chunked = transport.chunked;
    if (!chunked || file.size === 0 || file.size < directThresholdBytes) {
      const onProgress = (loaded: number): void =>
        this.#advanceProgress(itemIndex, loaded, item.relativePath);
      return withRetry(
        () => transport.direct(path, file, { signal: this.#signal, overwrite, onProgress }),
        retryDelaysMs,
        this.#signal,
      );
    }
    return this.#sendChunked(chunked, itemIndex, item, path, overwrite);
  }

  async #sendChunked(
    transport: ChunkedTransport,
    itemIndex: number,
    item: UploadItem,
    path: string,
    overwrite: boolean,
  ): Promise<Entry> {
    const { uploadId, chunkSize } = await withRetry(
      () => transport.init(path, item.file.size, { overwrite }),
      this.#options.retryDelaysMs,
      this.#signal,
    );
    const abortRemainingChunks = new AbortController();
    const abortOnCancel = (): void => abortRemainingChunks.abort();
    this.#signal.addEventListener('abort', abortOnCancel, { once: true });
    if (this.#signal.aborted) abortRemainingChunks.abort();
    const upload: ChunkedFileUpload = {
      transport,
      uploadId,
      chunkSize,
      item,
      itemIndex,
      abortRemainingChunks,
    };
    try {
      const chunkCount = validatedChunkCount(item.file.size, chunkSize, path);
      const results = await mapWithConcurrency(
        Array.from({ length: chunkCount }, (_, chunk) => chunk),
        this.#options.chunkConcurrency,
        (chunk) => this.#chunkSlots(() => this.#putChunk(upload, chunk)),
        abortRemainingChunks.signal,
      );
      const failure = failureOverItsCancellations(results);
      if (failure) throw failure;
      if (this.#signal.aborted) throw new FsError('cancelled');
      return await transport.complete(uploadId);
    } catch (error) {
      await transport.abort(uploadId).catch(ignoreError);
      throw error;
    } finally {
      this.#signal.removeEventListener('abort', abortOnCancel);
    }
  }

  async #putChunk(upload: ChunkedFileUpload, chunk: number): Promise<void> {
    const { transport, uploadId, chunkSize, item, itemIndex, abortRemainingChunks } = upload;
    const offset = chunk * chunkSize;
    const data = item.file.slice(offset, Math.min(item.file.size, offset + chunkSize));
    try {
      await withRetry(
        () => transport.put(uploadId, chunk, offset, data, abortRemainingChunks.signal),
        this.#options.chunkRetryDelaysMs,
        abortRemainingChunks.signal,
      );
    } catch (error) {
      abortRemainingChunks.abort();
      throw error;
    }
    this.#advanceProgress(itemIndex, this.#loaded[itemIndex]! + data.size, item.relativePath);
  }

  async #removeFilesCreatedByThisRun(): Promise<void> {
    const removed = new Set<string>();
    for (const path of this.#createdByThisRun) {
      try {
        if (await this.#options.exists(path)) {
          await this.#options.remove(path);
          removed.add(path);
        }
      } catch {
        continue;
      }
    }
    this.#uploaded = this.#uploaded.filter((entry) => !removed.has(entry.path));
  }
}

/**
 * An uploader over an `UploadTransport`. Files run `fileConcurrency` at a time; large files go in chunks that
 * share `chunkConcurrency` slots across the whole run; transient failures are retried. A conflicting target
 * is replaced, skipped or uploaded under a free `copy` name, as `onConflict` says. Cancelling removes the
 * files this run created.
 *
 * @example
 * ```ts
 * const uploader = createUploader({
 *   transport: adapter.upload!,
 *   exists,
 *   remove: (path) => adapter.delete!(path),
 * });
 * const { uploaded, failed } = await uploader.upload(items, 'inbox', { onProgress: render });
 * ```
 */
export function createUploader(options: UploaderOptions): Uploader {
  const resolved = withDefaults(options);
  return {
    async upload(items, targetDir, opts = {}) {
      const base = normalizePath(targetDir);
      return new UploadRun(resolved, base, items, opts).execute(items);
    },
  };
}
