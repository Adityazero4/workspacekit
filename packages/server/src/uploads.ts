import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { FsError } from '@scope/core';

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

/**
 * Chunked-upload bookkeeping. Chunks live in `<os.tmpdir()>/fs-uploads-*` (one dedicated
 * directory per handler, never inside the served root), one file per index, renamed into place
 * so re-putting an index is atomic and idempotent.
 */
export function createUploads(o: { ttlMs: number; chunkSize: number }): {
  init(path: string, totalBytes: number, overwrite: boolean): Promise<UploadSession>;
  get(id: string): UploadSession;
  put(s: UploadSession, index: number, offset: number, body: ReadableStream<Uint8Array> | null): Promise<void>;
  assemble(s: UploadSession): ReadableStream<Uint8Array>;
  remove(id: string): Promise<void>;
  sweep(): Promise<void>;
} {
  const sessions = new Map<string, UploadSession>();
  let baseP: Promise<string> | undefined;
  const getBase = (): Promise<string> =>
    (baseP ??= mkdtemp(path.join(tmpdir(), 'fs-uploads-')).catch((e: unknown) => {
      baseP = undefined;
      throw e;
    }));

  const remove = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await rm(s.dir, { recursive: true, force: true });
  };

  return {
    async init(p, totalBytes, overwrite) {
      const id = randomUUID();
      const dir = path.join(await getBase(), id);
      await mkdir(dir);
      const s: UploadSession = {
        id, path: p, totalBytes, overwrite, chunkSize: o.chunkSize, dir, active: 0, completing: false, lastSeen: Date.now(),
        count: Math.ceil(totalBytes / o.chunkSize), received: new Set(),
      };
      sessions.set(id, s);
      return s;
    },

    get(id) {
      const s = sessions.get(id);
      if (!s) throw new FsError('not_found', 'unknown upload');
      s.lastSeen = Date.now();
      return s;
    },

    async put(s, index, offset, body) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= s.count) throw new FsError('invalid', 'chunk index out of range');
      if (offset !== index * s.chunkSize) throw new FsError('invalid', 'chunk offset does not match its index');
      if (s.completing) throw new FsError('conflict', 'upload is completing');
      const expected = Math.min(s.chunkSize, s.totalBytes - offset);
      const part = path.join(s.dir, `${index}.${randomUUID()}.part`);
      let n = 0;
      s.active++;
      try {
        await pipeline(
          Readable.fromWeb((body ?? new Blob([]).stream()) as unknown as NodeWebStream<Uint8Array>),
          async function* (src: AsyncIterable<Uint8Array>) {
            for await (const c of src) {
              n += c.byteLength;
              if (n > s.chunkSize) throw new FsError('too_large', 'chunk larger than the chunk size');
              yield c;
            }
          },
          createWriteStream(part),
        );
        if (n !== expected) throw new FsError('invalid', `chunk ${index} must be ${expected} bytes`);
        if (!sessions.has(s.id)) throw new FsError('not_found', 'unknown upload'); // aborted meanwhile
        await rename(part, path.join(s.dir, String(index)));
        s.received.add(index);
      } catch (e) {
        await rm(part, { force: true }).catch(() => {});
        throw e;
      } finally {
        s.active--;
        s.lastSeen = Date.now();
      }
    },

    assemble(s) {
      for (let i = 0; i < s.count; i++) if (!s.received.has(i)) throw new FsError('invalid', `missing chunk ${i}`);
      async function* gen(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < s.count; i++) yield* createReadStream(path.join(s.dir, String(i)));
      }
      return Readable.toWeb(Readable.from(gen())) as unknown as ReadableStream<Uint8Array>;
    },

    remove,

    async sweep() {
      const now = Date.now();
      for (const s of [...sessions.values()]) if (!s.active && !s.completing && now - s.lastSeen > o.ttlMs) await remove(s.id);
    },
  };
}
