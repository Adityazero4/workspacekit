import { Zip, ZipPassThrough } from 'fflate';

export interface ZipEntry {
  /** Entry name inside the archive; a trailing `/` makes it a directory. */
  name: string;
  mtimeMs?: number | undefined;
  /** Opens the file's bytes lazily; `null` skips the entry (the file vanished meanwhile). Absent for directories. */
  open?: () => Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Streams a stored (uncompressed) zip. Pull-driven, so a slow client slows the file reads
 * instead of buffering the archive. A failure after the first byte errors the stream.
 */
export function zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  signal: AbortSignal,
  onError: (e: unknown) => void,
): ReadableStream<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else out.push(chunk);
  });
  function* drain(): Generator<Uint8Array> {
    if (failure) throw failure;
    while (out.length > 0) yield out.shift()!;
  }

  async function* gen(): AsyncGenerator<Uint8Array> {
    for await (const e of entries) {
      signal.throwIfAborted();
      const body = e.open ? await e.open() : undefined;
      if (body === null) continue;
      const file = new ZipPassThrough(e.name);
      // zip stores DOS dates; fflate throws mid-stream unless the *local* year is 1980-2099.
      if (e.mtimeMs !== undefined) {
        const year = new Date(e.mtimeMs).getFullYear();
        if (year >= 1980 && year <= 2099) file.mtime = new Date(e.mtimeMs);
      }
      zip.add(file);
      if (body) {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            signal.throwIfAborted();
            file.push(value);
            yield* drain();
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      file.push(new Uint8Array(0), true);
      yield* drain();
    }
    zip.end();
    yield* drain();
  }

  const it = gen();
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const r = await it.next();
          if (r.done) c.close();
          else c.enqueue(r.value);
        } catch (e) {
          if (!signal.aborted) onError(e);
          c.error(e);
        }
      },
      async cancel() {
        await it.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
