import { Zip, ZipPassThrough } from 'fflate';

const FIRST_DOS_YEAR = 1980;
const LAST_DOS_YEAR = 2099;
const ignoreError = (): void => undefined;

function dosRepresentableDate(mtimeMs: number | undefined): Date | undefined {
  if (mtimeMs === undefined) return undefined;
  const localYear = new Date(mtimeMs).getFullYear();
  return localYear >= FIRST_DOS_YEAR && localYear <= LAST_DOS_YEAR ? new Date(mtimeMs) : undefined;
}

/**
 * One entry of a streamed zip.
 *
 * @example
 * const entry: ZipEntry = { name: 'docs/a.txt', mtimeMs: Date.now(), open: async () => fileStream };
 */
export interface ZipEntry {
  /** Entry name inside the archive; a trailing `/` makes it a directory. */
  name: string;
  mtimeMs?: number | undefined;
  /**
   * Opens the file's bytes lazily; `null` skips the entry (the file vanished meanwhile). Absent for
   * directories.
   */
  open?: () => Promise<ReadableStream<Uint8Array> | null>;
}

class ZipOutput {
  readonly #written: Uint8Array[] = [];
  #failure: Error | undefined;
  readonly zip: Zip = new Zip((error, chunk) => {
    if (error) this.#failure = error;
    else this.#written.push(chunk);
  });

  *drain(): Generator<Uint8Array> {
    if (this.#failure) throw this.#failure;
    while (this.#written.length > 0) yield this.#written.shift()!;
  }
}

async function* pipeFile(
  output: ZipOutput,
  file: ZipPassThrough,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      signal.throwIfAborted();
      file.push(value);
      yield* output.drain();
    }
  } finally {
    await reader.cancel().catch(ignoreError);
  }
}

async function* archiveChunks(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const output = new ZipOutput();
  for await (const entry of entries) {
    signal.throwIfAborted();
    const body = entry.open ? await entry.open() : undefined;
    const vanished = body === null;
    if (vanished) continue;
    const file = new ZipPassThrough(entry.name);
    const mtime = dosRepresentableDate(entry.mtimeMs);
    if (mtime) file.mtime = mtime;
    output.zip.add(file);
    if (body) yield* pipeFile(output, file, body, signal);
    file.push(new Uint8Array(0), true);
    yield* output.drain();
  }
  output.zip.end();
  yield* output.drain();
}

/**
 * Streams a stored (uncompressed) zip. Pull-driven, so a slow client slows the file reads
 * instead of buffering the archive. A failure after the first byte errors the stream.
 * Zip stores DOS dates, so a modification time outside the local years 1980–2099 is left out.
 *
 * @example
 * const entries = [{ name: 'notes/' }, { name: 'notes/a.txt', open: async () => fileStream }];
 * const body = zipStream(entries, signal, log);
 */
export function zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  signal: AbortSignal,
  onError: (e: unknown) => void,
): ReadableStream<Uint8Array> {
  const chunks = archiveChunks(entries, signal);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          if (!signal.aborted) onError(error);
          controller.error(error);
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
