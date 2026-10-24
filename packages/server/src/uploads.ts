import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { FsError } from '@workspacekit/core';
import {
  claimUploadFolder,
  freshUploadFolder,
  ownedUploadFolder,
  releaseUploadFolder,
} from './upload-temp-dir';

/**
 * The bookkeeping of one chunked upload, from `init` until it completes, is aborted or idles out.
 *
 * @example
 * const session = await uploads.init('video.mp4', file.size, false, 'alice');
 */
export interface UploadSession {
  readonly id: string;
  /** Normalized target path, relative to the store root. */
  readonly path: string;
  readonly totalBytes: number;
  readonly overwrite: boolean;
  readonly chunkSize: number;
  readonly count: number;
  /** The principal that started it, when the handler has an `actor` hook. */
  readonly actor: string | undefined;
  /** Chunk indexes being written; a busy session is never swept or evicted. */
  readonly inFlight: Set<number>;
  /** Set while `complete` runs: no second complete, no more chunks. */
  completing: boolean;
  lastSeen: number;
  readonly dir: string;
  /** Size of each stored chunk, by index. */
  readonly storedChunks: Map<number, number>;
  /** Bytes on disk for this session, stored chunks and chunks being written alike. */
  storedBytes: number;
}

type UploadBody = ReadableStream<Uint8Array> | null;

/**
 * How chunked uploads are kept: chunk size, idle lifetime, the caps on unfinished sessions and on their
 * declared bytes (in all and per actor), and an optional integrator-owned `tempDir` (otherwise a fresh
 * private folder).
 *
 * @example
 * const limits: UploadLimits = {
 *   ttlMs: 3_600_000,
 *   chunkSize: 8 * 1024 ** 2,
 *   maxSessions: 100,
 *   maxSessionsPerActor: 25,
 *   maxTempBytes: 4 * 1024 ** 3,
 *   maxTempBytesPerActor: 1024 ** 3,
 * };
 */
export interface UploadLimits {
  ttlMs: number;
  chunkSize: number;
  maxSessions: number;
  maxSessionsPerActor: number;
  maxTempBytes: number;
  maxTempBytesPerActor: number;
  tempDir?: string | undefined;
}

const LONGEST_TIMER_MS = 2 ** 31 - 1;
const MAX_CHUNKS_IN_FLIGHT_PER_UPLOAD = 8;
const ignoreError = (): void => undefined;
const isIdle = (session: UploadSession): boolean => session.inFlight.size === 0 && !session.completing;

async function writeChunkCapped(
  body: UploadBody,
  partPath: string,
  chunkSize: number,
  reserve: (bytes: number) => void,
): Promise<number> {
  let received = 0;
  await pipeline(
    Readable.fromWeb((body ?? new Blob([]).stream()) as unknown as NodeWebStream<Uint8Array>),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > chunkSize) throw new FsError('too_large', 'chunk larger than the chunk size');
        reserve(chunk.byteLength);
        yield chunk;
      }
    },
    createWriteStream(partPath),
  );
  return received;
}

class ChunkedUploads {
  readonly #sessions = new Map<string, UploadSession>();
  readonly #limits: UploadLimits;
  #usedBytes = 0;
  #baseDirPending: Promise<string> | undefined;
  #baseDirPath: string | undefined;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(limits: UploadLimits) {
    this.#limits = limits;
  }

  async init(
    path: string,
    totalBytes: number,
    overwrite: boolean,
    actor: string | undefined,
  ): Promise<UploadSession | null> {
    const baseDir = await this.#baseDir();
    const evicted = this.#evictionsToMakeRoom(totalBytes, actor);
    if (!evicted) return null;
    claimUploadFolder(baseDir, this);
    for (const old of evicted) this.#detach(old);
    const id = randomUUID();
    const session = this.#newSession({ id, dir: join(baseDir, id), path, totalBytes, overwrite, actor });
    this.#sessions.set(id, session);
    claimUploadFolder(baseDir, this);
    this.#startSweeping();
    try {
      await mkdir(session.dir);
    } catch (error) {
      await this.remove(session.id);
      throw error;
    }
    for (const old of evicted) await rm(old.dir, { recursive: true, force: true }).catch(ignoreError);
    return session;
  }

  peek(id: string): UploadSession {
    const session = this.#sessions.get(id);
    if (!session) throw new FsError('not_found', 'unknown upload');
    return session;
  }

  touch(session: UploadSession): void {
    session.lastSeen = Date.now();
  }

  async put(session: UploadSession, index: number, offset: number, body: UploadBody): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.count) {
      throw new FsError('invalid', 'chunk index out of range');
    }
    if (offset !== index * session.chunkSize) {
      throw new FsError('invalid', 'chunk offset does not match its index');
    }
    if (session.completing) throw new FsError('conflict', 'upload is completing');
    assertMayStartChunk(session, index);
    const expected = Math.min(session.chunkSize, session.totalBytes - offset);
    const partPath = join(session.dir, `${index}.${randomUUID()}.part`);
    let partBytes = 0;
    const reserve = (bytes: number): void => {
      this.#reserve(session, bytes);
      partBytes += bytes;
    };
    session.inFlight.add(index);
    try {
      const received = await writeChunkCapped(body, partPath, session.chunkSize, reserve);
      if (received !== expected) throw new FsError('invalid', `chunk ${index} must be ${expected} bytes`);
      this.#assertStillOpen(session);
      await rename(partPath, join(session.dir, String(index)));
      this.#assertStillOpen(session);
      this.#store(session, index, partBytes);
      partBytes = 0;
    } catch (error) {
      this.#unreserve(session, partBytes);
      await rm(partPath, { force: true }).catch(ignoreError);
      throw error;
    } finally {
      session.inFlight.delete(index);
      session.lastSeen = Date.now();
    }
  }

  assemble(session: UploadSession): ReadableStream<Uint8Array> {
    for (let index = 0; index < session.count; index++) {
      if (!session.storedChunks.has(index)) throw new FsError('invalid', `missing chunk ${index}`);
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
    this.#detach(session);
    await rm(session.dir, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.#sessions.values()]) {
      if (isIdle(session) && now - session.lastSeen > this.#limits.ttlMs) await this.remove(session.id);
    }
  }

  #newSession(
    start: Pick<UploadSession, 'id' | 'dir' | 'path' | 'totalBytes' | 'overwrite' | 'actor'>,
  ): UploadSession {
    const { chunkSize } = this.#limits;
    return {
      ...start,
      chunkSize,
      count: Math.ceil(start.totalBytes / chunkSize),
      completing: false,
      lastSeen: Date.now(),
      inFlight: new Set(),
      storedChunks: new Map(),
      storedBytes: 0,
    };
  }

  #detach(session: UploadSession): void {
    if (!this.#sessions.delete(session.id)) return;
    let stored = 0;
    for (const bytes of session.storedChunks.values()) stored += bytes;
    session.storedChunks.clear();
    this.#unreserve(session, stored);
    if (this.#sessions.size > 0) return;
    this.#stopSweeping();
    if (this.#baseDirPath !== undefined) releaseUploadFolder(this.#baseDirPath, this);
  }

  #assertStillOpen(session: UploadSession): void {
    if (!this.#sessions.has(session.id)) throw new FsError('not_found', 'unknown upload');
  }

  #reserve(session: UploadSession, bytes: number): void {
    if (this.#usedBytes + bytes > this.#limits.maxTempBytes) {
      throw new FsError('too_large', 'upload temp storage is full; try again later', { path: session.path });
    }
    if (session.storedBytes + bytes > session.totalBytes + session.chunkSize) {
      throw new FsError('too_large', 'this upload already holds its total plus one chunk', {
        path: session.path,
      });
    }
    this.#usedBytes += bytes;
    session.storedBytes += bytes;
  }

  #unreserve(session: UploadSession, bytes: number): void {
    this.#usedBytes -= bytes;
    session.storedBytes -= bytes;
  }

  #store(session: UploadSession, index: number, bytes: number): void {
    this.#unreserve(session, session.storedChunks.get(index) ?? 0);
    session.storedChunks.set(index, bytes);
  }

  #evictionsToMakeRoom(totalBytes: number, actor: string | undefined): UploadSession[] | null {
    const evictable =
      actor === undefined
        ? []
        : [...this.#sessions.values()]
            .filter((session) => session.actor === actor && isIdle(session))
            .sort((a, b) => a.lastSeen - b.lastSeen);
    const leaving: UploadSession[] = [];
    while (!this.#hasRoomFor(totalBytes, actor, leaving)) {
      const next = evictable[leaving.length];
      if (!next) return null;
      leaving.push(next);
    }
    return leaving;
  }

  #hasRoomFor(totalBytes: number, actor: string | undefined, leaving: UploadSession[]): boolean {
    let sessions = 0;
    let sessionsOfActor = 0;
    let reservedBytes = totalBytes;
    let reservedBytesOfActor = totalBytes;
    for (const session of this.#sessions.values()) {
      if (leaving.includes(session)) continue;
      sessions++;
      reservedBytes += session.totalBytes;
      if (actor === undefined || session.actor !== actor) continue;
      sessionsOfActor++;
      reservedBytesOfActor += session.totalBytes;
    }
    const { maxSessions, maxSessionsPerActor, maxTempBytes, maxTempBytesPerActor } = this.#limits;
    const actorHasRoom =
      actor === undefined ||
      (sessionsOfActor < maxSessionsPerActor && reservedBytesOfActor <= maxTempBytesPerActor);
    return sessions < maxSessions && reservedBytes <= maxTempBytes && actorHasRoom;
  }

  #startSweeping(): void {
    if (this.#sweepTimer !== undefined) return;
    const every = Math.min(Math.max(this.#limits.ttlMs / 4, 1), LONGEST_TIMER_MS);
    this.#sweepTimer = setInterval(() => void this.sweep().catch(ignoreError), every);
    this.#sweepTimer.unref();
  }

  #stopSweeping(): void {
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  #baseDir(): Promise<string> {
    const { tempDir, ttlMs } = this.#limits;
    const prepare = (): Promise<string> =>
      tempDir === undefined ? freshUploadFolder() : ownedUploadFolder(tempDir, ttlMs, this);
    return (this.#baseDirPending ??= prepare().then(
      (dir) => (this.#baseDirPath = dir),
      (error: unknown) => {
        this.#baseDirPending = undefined;
        throw error;
      },
    ));
  }
}

function assertMayStartChunk(session: UploadSession, index: number): void {
  if (session.inFlight.has(index)) {
    throw new FsError('conflict', `chunk ${index} is already being uploaded`, { path: session.path });
  }
  if (session.inFlight.size >= MAX_CHUNKS_IN_FLIGHT_PER_UPLOAD) {
    throw new FsError(
      'conflict',
      `at most ${MAX_CHUNKS_IN_FLIGHT_PER_UPLOAD} chunks of one upload may be sent at once`,
      { path: session.path },
    );
  }
}

/**
 * Chunked-upload bookkeeping. By default each instance keeps its chunks in a fresh private folder
 * (`mkdtemp`, mode 0700) under the system temp directory, removed on a best-effort basis when the process
 * exits. With `tempDir`, chunks go to that integrator-owned folder instead, which must be a folder owned by
 * this user with mode 0700 and used by no other live instance; its first use removes the session folders a
 * previous run left behind once they are older than the TTL.
 *
 * Every byte written is counted: a chunk is refused while it streams once the instance would hold more than
 * `maxTempBytes`, or the upload more than its total plus one chunk. A chunk index can be in flight only once,
 * and at most 8 chunks of one upload at a time. `init` answers `null` at the session or byte cap, after first
 * evicting the same actor's oldest idle sessions when that makes room. Idle sessions are swept on an unref'd
 * timer that runs only while sessions exist.
 *
 * @example
 * const uploads = createUploads(limits);
 */
export function createUploads(o: UploadLimits): {
  init(
    path: string,
    totalBytes: number,
    overwrite: boolean,
    actor: string | undefined,
  ): Promise<UploadSession | null>;
  /** The session with this id, without counting the lookup as activity. */
  peek(id: string): UploadSession;
  /** Counts an authorized request as activity, so the session is not swept. */
  touch(s: UploadSession): void;
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
