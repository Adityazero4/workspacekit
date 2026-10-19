import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { FsError } from '@scope/core';

/**
 * The bookkeeping of one chunked upload, from `init` until it completes, is aborted or idles out.
 *
 * @example
 * const session = await uploads.init('video.mp4', file.size, false);
 */
export interface UploadSession {
  readonly id: string;
  /** Normalized target path, relative to the store root. */
  readonly path: string;
  readonly totalBytes: number;
  readonly overwrite: boolean;
  readonly chunkSize: number;
  readonly count: number;
  /** Requests in flight; a busy session is never swept. */
  active: number;
  /** Set while `complete` runs: no second complete, no more chunks. */
  completing: boolean;
  lastSeen: number;
  readonly dir: string;
  readonly received: Set<number>;
}

type UploadBody = ReadableStream<Uint8Array> | null;

async function writeChunkCapped(body: UploadBody, partPath: string, chunkSize: number): Promise<number> {
  let received = 0;
  await pipeline(
    Readable.fromWeb((body ?? new Blob([]).stream()) as unknown as NodeWebStream<Uint8Array>),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > chunkSize) throw new FsError('too_large', 'chunk larger than the chunk size');
        yield chunk;
      }
    },
    createWriteStream(partPath),
  );
  return received;
}

class ChunkedUploads {
  readonly #sessions = new Map<string, UploadSession>();
  readonly #ttlMs: number;
  readonly #chunkSize: number;
  #baseDirPending: Promise<string> | undefined;

  constructor(options: { ttlMs: number; chunkSize: number }) {
    this.#ttlMs = options.ttlMs;
    this.#chunkSize = options.chunkSize;
  }

  async init(path: string, totalBytes: number, overwrite: boolean): Promise<UploadSession> {
    const id = randomUUID();
    const dir = join(await this.#baseDir(), id);
    await mkdir(dir);
    const session: UploadSession = {
      id,
      path,
      totalBytes,
      overwrite,
      chunkSize: this.#chunkSize,
      dir,
      active: 0,
      completing: false,
      lastSeen: Date.now(),
      count: Math.ceil(totalBytes / this.#chunkSize),
      received: new Set(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  get(id: string): UploadSession {
    const session = this.#sessions.get(id);
    if (!session) throw new FsError('not_found', 'unknown upload');
    session.lastSeen = Date.now();
    return session;
  }

  async put(session: UploadSession, index: number, offset: number, body: UploadBody): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.count) {
      throw new FsError('invalid', 'chunk index out of range');
    }
    if (offset !== index * session.chunkSize) {
      throw new FsError('invalid', 'chunk offset does not match its index');
    }
    if (session.completing) throw new FsError('conflict', 'upload is completing');
    const expected = Math.min(session.chunkSize, session.totalBytes - offset);
    const partPath = join(session.dir, `${index}.${randomUUID()}.part`);
    session.active++;
    try {
      const received = await writeChunkCapped(body, partPath, session.chunkSize);
      if (received !== expected) throw new FsError('invalid', `chunk ${index} must be ${expected} bytes`);
      const abortedMeanwhile = !this.#sessions.has(session.id);
      if (abortedMeanwhile) throw new FsError('not_found', 'unknown upload');
      await rename(partPath, join(session.dir, String(index)));
      session.received.add(index);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      session.active--;
      session.lastSeen = Date.now();
    }
  }

  assemble(session: UploadSession): ReadableStream<Uint8Array> {
    for (let index = 0; index < session.count; index++) {
      if (!session.received.has(index)) throw new FsError('invalid', `missing chunk ${index}`);
    }
    async function* chunksInOrder(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < session.count; index++) {
        yield* createReadStream(join(session.dir, String(index)));
      }
    }
    return Readable.toWeb(Readable.from(chunksInOrder())) as unknown as ReadableStream<Uint8Array>;
  }

  async remove(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    await rm(session.dir, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.#sessions.values()]) {
      const idle = !session.active && !session.completing && now - session.lastSeen > this.#ttlMs;
      if (idle) await this.remove(session.id);
    }
  }

  #baseDir(): Promise<string> {
    return (this.#baseDirPending ??= mkdtemp(join(tmpdir(), 'fs-uploads-')).catch((error: unknown) => {
      this.#baseDirPending = undefined;
      throw error;
    }));
  }
}

/**
 * Chunked-upload bookkeeping. Chunks live in `<os.tmpdir()>/fs-uploads-*` (one dedicated
 * directory per handler, never inside the served root), one file per index, renamed into place
 * so re-putting an index is atomic and idempotent.
 *
 * @example
 * const uploads = createUploads({ ttlMs: 3_600_000, chunkSize: 8 * 1024 * 1024 });
 */
export function createUploads(o: { ttlMs: number; chunkSize: number }): {
  init(path: string, totalBytes: number, overwrite: boolean): Promise<UploadSession>;
  get(id: string): UploadSession;
  put(
    s: UploadSession,
    index: number,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<void>;
  /** Throws `invalid` when a chunk is missing. */
  assemble(s: UploadSession): ReadableStream<Uint8Array>;
  remove(id: string): Promise<void>;
  sweep(): Promise<void>;
} {
  return new ChunkedUploads(o);
}
