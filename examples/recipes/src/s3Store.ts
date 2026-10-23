import {
  FsError,
  isFsError,
  isSameOrDescendant,
  normalizePath,
  type Entry,
  type EntryKind,
  type TransferOptions,
} from '@scope/core';
import type { FileStore } from '@scope/server';

interface ListedObject {
  Key?: string;
  ETag?: string;
  Size?: number;
  LastModified?: Date;
}

interface ListPage {
  Contents?: ListedObject[];
  CommonPrefixes?: Array<{ Prefix?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

/**
 * The part of an AWS SDK v3 `S3` client that `s3Store` calls. Each method mirrors the aggregated client's
 * call of the same name (`GetObject`, `PutObject` with `IfMatch` / `IfNoneMatch`, `DeleteObject`,
 * `ListObjectsV2`, `CopyObject`), using only the input and output fields listed here, so
 * `new S3({ region })` from `@aws-sdk/client-s3` is meant to satisfy it; this package does not depend on
 * the SDK, so that fit is by construction and not checked by the compiler. A small fake satisfies it in
 * tests.
 *
 * @example
 * import { S3 } from '@aws-sdk/client-s3';
 * const client: S3Like = new S3({ region: 'us-east-1' });
 */
export interface S3Like {
  getObject(input: { Bucket: string; Key: string; Range?: string }): Promise<{
    Body?: { transformToWebStream(): ReadableStream<Uint8Array> };
    ContentLength?: number;
    ETag?: string;
    LastModified?: Date;
  }>;
  putObject(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    IfNoneMatch?: string;
    IfMatch?: string;
  }): Promise<unknown>;
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>;
  listObjectsV2(input: {
    Bucket: string;
    Prefix?: string;
    Delimiter?: string;
    ContinuationToken?: string;
    MaxKeys?: number;
  }): Promise<ListPage>;
  copyObject(input: { Bucket: string; Key: string; CopySource: string }): Promise<unknown>;
}

const IMPLICIT_DIRECTORY_MTIME_MS = 0;
const SLASH = '/';

const KIND_BY_S3_ERROR_NAME: Record<string, FsError['kind']> = {
  NoSuchKey: 'not_found',
  NotFound: 'not_found',
  PreconditionFailed: 'conflict',
  ConditionalRequestConflict: 'conflict',
  AccessDenied: 'forbidden',
  InvalidRange: 'invalid',
  RequestTimeout: 'timeout',
  SlowDown: 'network',
  ServiceUnavailable: 'network',
  InternalError: 'network',
};

const KIND_BY_HTTP_STATUS: Record<number, FsError['kind']> = {
  404: 'not_found',
  412: 'conflict',
  403: 'forbidden',
  416: 'invalid',
  408: 'timeout',
  504: 'timeout',
  429: 'network',
  500: 'network',
  502: 'network',
  503: 'network',
};

function errorKindOfS3(error: unknown): FsError['kind'] {
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = $metadata?.httpStatusCode;
  return (
    (name !== undefined ? KIND_BY_S3_ERROR_NAME[name] : undefined) ??
    (status !== undefined ? KIND_BY_HTTP_STATUS[status] : undefined) ??
    'unknown'
  );
}

const BUCKET_UNAVAILABLE =
  'the S3 bucket does not exist or is not reachable: check the bucket name, region and credentials';

function toFsError(error: unknown, rel: string): FsError {
  if (isFsError(error)) return error;
  if ((error as { name?: string } | null)?.name === 'NoSuchBucket') {
    return new FsError('unknown', BUCKET_UNAVAILABLE, { path: rel, cause: error });
  }
  const kind = errorKindOfS3(error);
  return new FsError(kind, `S3 request failed (${kind}): ${rel || SLASH}`, { path: rel, cause: error });
}

function isAddressableName(name: string): boolean {
  try {
    return name !== '' && normalizePath(name) === name && !name.includes(SLASH);
  } catch {
    return false;
  }
}

function isMissingKey(error: unknown): boolean {
  return (error as { name?: string } | null)?.name !== 'NoSuchBucket' && errorKindOfS3(error) === 'not_found';
}

function changedSinceRead(rel: string): FsError {
  return new FsError('conflict', `file changed: ${rel}`, { path: rel });
}

function notFound(rel: string): FsError {
  return new FsError('not_found', `no such file or folder: ${rel}`, { path: rel });
}

function assertNotRoot(rel: string): void {
  if (rel === '') throw new FsError('invalid', 'operation not allowed on the root', { path: rel });
}

function entryOf(rel: string, kind: EntryKind, size: number | null, mtimeMs: number): Entry {
  return { path: rel, name: rel.slice(rel.lastIndexOf(SLASH) + 1), kind, size, mtimeMs };
}

async function collectBytes(
  data: ReadableStream<Uint8Array> | Uint8Array,
  maxBytes: number | undefined,
  rel: string,
): Promise<Uint8Array> {
  const chunks = data instanceof Uint8Array ? [data] : [];
  let total = data instanceof Uint8Array ? data.byteLength : 0;
  const tooLarge = (): FsError =>
    new FsError('too_large', `exceeds ${maxBytes} bytes: ${rel}`, { path: rel });
  if (maxBytes !== undefined && total > maxBytes) throw tooLarge();
  if (!(data instanceof Uint8Array)) {
    const reader = data.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      total += chunk.value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function satisfiableRange(
  range: { start: number; end: number },
  size: number,
  rel: string,
): { start: number; end: number } {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    throw new FsError('invalid', `unsatisfiable range: ${rel}`, { path: rel });
  }
  return { start, end: Math.min(end, size - 1) };
}

class S3Store implements FileStore {
  readonly #client: S3Like;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(client: S3Like, bucket: string, prefix: string) {
    this.#client = client;
    this.#bucket = bucket;
    const normalizedPrefix = normalizePath(prefix);
    this.#prefix = normalizedPrefix === '' ? '' : `${normalizedPrefix}/`;
  }

  list = (requestedPath: string, depth: number): Promise<Entry[]> =>
    this.#run(requestedPath, async (rel) => {
      const root = await this.#statAt(rel);
      if (!root) throw notFound(rel);
      if (root.kind !== 'directory') throw new FsError('invalid', `not a directory: ${rel}`, { path: rel });
      const entries: Entry[] = [];
      let level = [rel];
      for (let levelDepth = 0; levelDepth < depth && level.length > 0; levelDepth++) {
        const children = (await Promise.all(level.map((directory) => this.#listLevel(directory)))).flat();
        entries.push(...children);
        level = children.filter((child) => child.kind === 'directory').map((child) => child.path);
      }
      return entries;
    });

  stat = (requestedPath: string): Promise<Entry | null> =>
    this.#run(requestedPath, (rel) => this.#statAt(rel));

  read = (
    requestedPath: string,
    range?: { start: number; end: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; entry: Entry }> =>
    this.#run(requestedPath, async (rel) => {
      const entry = await this.#statAt(rel);
      if (!entry) throw notFound(rel);
      if (entry.kind === 'directory') throw new FsError('invalid', `is a directory: ${rel}`, { path: rel });
      const bounds = range ? satisfiableRange(range, entry.size ?? 0, rel) : undefined;
      const object = await this.#client.getObject({
        Bucket: this.#bucket,
        Key: this.#keyOf(rel),
        Range: bounds ? `bytes=${bounds.start}-${bounds.end}` : undefined,
      });
      if (!object.Body) throw new FsError('unknown', `S3 returned no body: ${rel}`, { path: rel });
      const size = bounds ? bounds.end - bounds.start + 1 : (entry.size ?? 0);
      return { body: object.Body.transformToWebStream(), size, entry };
    });

  write = (
    requestedPath: string,
    data: ReadableStream<Uint8Array> | Uint8Array,
    options: { expectedMtimeMs?: number; overwrite?: boolean; maxBytes?: number } = {},
  ): Promise<Entry> =>
    this.#run(requestedPath, async (rel) => {
      assertNotRoot(rel);
      const bytes = await collectBytes(data, options.maxBytes, rel);
      const found = await this.#lookup(rel);
      this.#assertWritable(found, options, rel);
      if (options.expectedMtimeMs !== undefined && found && !found.etag) throw changedSinceRead(rel);
      try {
        await this.#client.putObject({
          Bucket: this.#bucket,
          Key: this.#keyOf(rel),
          Body: bytes,
          IfNoneMatch: found ? undefined : '*',
          IfMatch: options.expectedMtimeMs === undefined ? undefined : found?.etag,
        });
      } catch (error) {
        throw isMissingKey(error) && found ? changedSinceRead(rel) : error;
      }
      return this.#existingEntry(rel);
    });

  create = (requestedPath: string, kind: EntryKind): Promise<Entry> =>
    this.#run(requestedPath, async (rel) => {
      assertNotRoot(rel);
      if (await this.#statAt(rel)) throw new FsError('conflict', `already exists: ${rel}`, { path: rel });
      const key = kind === 'directory' ? this.#directoryPrefixOf(rel) : this.#keyOf(rel);
      await this.#client.putObject({
        Bucket: this.#bucket,
        Key: key,
        Body: new Uint8Array(),
        IfNoneMatch: '*',
      });
      return this.#existingEntry(rel);
    });

  move = (from: string, to: string, options?: TransferOptions): Promise<Entry> =>
    this.#transfer('move', from, to, options);

  copy = (from: string, to: string, options?: TransferOptions): Promise<Entry> =>
    this.#transfer('copy', from, to, options);

  delete = (requestedPath: string): Promise<void> =>
    this.#run(requestedPath, async (rel) => {
      assertNotRoot(rel);
      const entry = await this.#statAt(rel);
      if (!entry) throw notFound(rel);
      await this.#deleteKeys(entry.kind === 'directory' ? await this.#keysUnder(rel) : [this.#keyOf(rel)]);
    });

  search = (query: string, limit: number): Promise<Entry[]> =>
    this.#run('', async () => {
      const needle = query.normalize('NFC').toLowerCase();
      if (!needle || limit < 1) return [];
      const found = new Map<string, Entry>();
      for await (const object of this.#objectsUnder(this.#prefix)) {
        for (const entry of this.#entriesFromObject(object)) {
          if (entry.name.toLowerCase().includes(needle)) found.set(entry.path, entry);
          if (found.size >= limit) return [...found.values()];
        }
      }
      return [...found.values()].slice(0, limit);
    });

  #keyOf(rel: string): string {
    return `${this.#prefix}${rel}`;
  }

  #directoryPrefixOf(rel: string): string {
    return rel === '' ? this.#prefix : `${this.#prefix}${rel}/`;
  }

  #relOf(key: string): string {
    return key.slice(this.#prefix.length);
  }

  async #run<T>(requestedPath: string, operation: (rel: string) => Promise<T>): Promise<T> {
    const rel = normalizePath(requestedPath);
    try {
      return await operation(rel);
    } catch (error) {
      throw toFsError(error, rel);
    }
  }

  async *#pages(input: { Prefix: string; Delimiter?: string; MaxKeys?: number }): AsyncGenerator<ListPage> {
    let token: string | undefined;
    do {
      const page = await this.#client.listObjectsV2({
        Bucket: this.#bucket,
        ...input,
        ContinuationToken: token,
      });
      yield page;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async *#objectsUnder(prefix: string): AsyncGenerator<ListedObject> {
    for await (const page of this.#pages({ Prefix: prefix })) yield* page.Contents ?? [];
  }

  async #keysUnder(rel: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const object of this.#objectsUnder(this.#directoryPrefixOf(rel))) {
      if (object.Key !== undefined) keys.push(object.Key);
    }
    return keys;
  }

  async #deleteKeys(keys: string[]): Promise<void> {
    for (const key of keys) await this.#client.deleteObject({ Bucket: this.#bucket, Key: key });
  }

  async #listLevel(directory: string): Promise<Entry[]> {
    const prefix = this.#directoryPrefixOf(directory);
    const entries: Entry[] = [];
    for await (const page of this.#pages({ Prefix: prefix, Delimiter: SLASH })) {
      for (const { Prefix } of page.CommonPrefixes ?? []) {
        const name = Prefix?.slice(prefix.length, -1) ?? '';
        if (isAddressableName(name)) {
          entries.push(
            entryOf(
              directory ? `${directory}/${name}` : name,
              'directory',
              null,
              IMPLICIT_DIRECTORY_MTIME_MS,
            ),
          );
        }
      }
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(prefix.length) ?? '';
        if (isAddressableName(name)) {
          entries.push(
            entryOf(
              directory ? `${directory}/${name}` : name,
              'file',
              object.Size ?? 0,
              object.LastModified?.getTime() ?? 0,
            ),
          );
        }
      }
    }
    return entries;
  }

  async #statAt(rel: string): Promise<Entry | null> {
    return (await this.#lookup(rel))?.entry ?? null;
  }

  async #lookup(rel: string): Promise<{ entry: Entry; etag?: string } | null> {
    if (rel === '') return { entry: entryOf('', 'directory', null, IMPLICIT_DIRECTORY_MTIME_MS) };
    const fileKey = this.#keyOf(rel);
    const file = (await this.#firstObjectWithPrefix(fileKey)).find((object) => object.Key === fileKey);
    if (file) {
      const mtimeMs = file.LastModified?.getTime() ?? 0;
      return { entry: entryOf(rel, 'file', file.Size ?? 0, mtimeMs), etag: file.ETag };
    }
    const directoryPrefix = this.#directoryPrefixOf(rel);
    const [inside] = await this.#firstObjectWithPrefix(directoryPrefix);
    if (!inside) return null;
    const isMarker = inside.Key === directoryPrefix;
    const mtimeMs = isMarker ? (inside.LastModified?.getTime() ?? 0) : IMPLICIT_DIRECTORY_MTIME_MS;
    return { entry: entryOf(rel, 'directory', null, mtimeMs) };
  }

  #assertWritable(
    found: { entry: Entry } | null,
    options: { expectedMtimeMs?: number; overwrite?: boolean },
    rel: string,
  ): void {
    if (found?.entry.kind === 'directory') {
      throw new FsError('conflict', `is a directory: ${rel}`, { path: rel });
    }
    if (found && options.overwrite === false) {
      throw new FsError('conflict', `already exists: ${rel}`, { path: rel });
    }
    const expected = options.expectedMtimeMs;
    if (expected !== undefined && found?.entry.mtimeMs !== expected) throw changedSinceRead(rel);
  }

  async #firstObjectWithPrefix(prefix: string): Promise<ListedObject[]> {
    const page = await this.#client.listObjectsV2({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1 });
    return page.Contents ?? [];
  }

  async #existingEntry(rel: string): Promise<Entry> {
    const entry = await this.#statAt(rel);
    if (!entry) throw notFound(rel);
    return entry;
  }

  #entriesFromObject(object: ListedObject): Entry[] {
    const relativeKey = this.#relOf(object.Key ?? '');
    const segments = relativeKey.split(SLASH);
    const isMarker = segments[segments.length - 1] === '';
    const names = isMarker ? segments.slice(0, -1) : segments;
    if (names.length === 0 || !names.every(isAddressableName)) return [];
    const entries = names
      .slice(0, isMarker ? undefined : -1)
      .map((_, depth) =>
        entryOf(names.slice(0, depth + 1).join(SLASH), 'directory', null, IMPLICIT_DIRECTORY_MTIME_MS),
      );
    if (!isMarker) {
      entries.push(entryOf(names.join(SLASH), 'file', object.Size ?? 0, object.LastModified?.getTime() ?? 0));
    }
    return entries;
  }

  async #transfer(
    kind: 'move' | 'copy',
    from: string,
    to: string,
    options: TransferOptions = {},
  ): Promise<Entry> {
    const target = normalizePath(to);
    return this.#run(from, async (source) => {
      assertNotRoot(source);
      assertNotRoot(target);
      const entry = await this.#statAt(source);
      if (!entry) throw notFound(source);
      if (source === target) return entry;
      if (isSameOrDescendant(target, source) || isSameOrDescendant(source, target)) {
        throw new FsError('invalid', `cannot ${kind} a folder into itself`, { path: source });
      }
      const replaced = await this.#statAt(target);
      if (replaced && !options.overwrite) {
        throw new FsError('conflict', `already exists: ${target}`, { path: target });
      }
      const sourceKeys = entry.kind === 'directory' ? await this.#keysUnder(source) : [this.#keyOf(source)];
      const copiedKeys = new Set<string>();
      for (const key of sourceKeys) {
        const targetKey = this.#keyOf(target) + this.#relOf(key).slice(source.length);
        await this.#copyKey(key, targetKey);
        copiedKeys.add(targetKey);
      }
      const leftoverKeys = replaced ? await this.#keysOfEntry(replaced, target) : [];
      await this.#deleteKeys(leftoverKeys.filter((key) => !copiedKeys.has(key)));
      if (kind === 'move') await this.#deleteKeys(sourceKeys);
      return this.#existingEntry(target);
    });
  }

  async #keysOfEntry(entry: Entry, rel: string): Promise<string[]> {
    return entry.kind === 'directory' ? this.#keysUnder(rel) : [this.#keyOf(rel)];
  }

  async #copyKey(sourceKey: string, targetKey: string): Promise<void> {
    const encodedKey = sourceKey.split(SLASH).map(encodeURIComponent).join(SLASH);
    await this.#client.copyObject({
      Bucket: this.#bucket,
      Key: targetKey,
      CopySource: `${this.#bucket}/${encodedKey}`,
    });
  }
}

/**
 * A `FileStore` over one S3 bucket (or one prefix of it), for `createFileHandler`. Files are objects;
 * folders are the `/` in keys, and `create(path, 'directory')` writes a zero-byte `path/` marker so an
 * empty folder survives. Limits to know: S3 times have one-second resolution, folders without a marker
 * report `mtimeMs: 0` and vanish with their last file, `expectedMtimeMs` is compared with the stored
 * time and the write is then sent with `IfMatch` on the ETag it read, so a change between that read and
 * the write is a `conflict`. A change made after the client read the file but within the same second as
 * the time it holds is not caught, because `expectedMtimeMs` is all the client sends; carry the ETag to the
 * client yourself if that matters. A file created by someone else between the check and the write is also
 * a `conflict`, not overwritten. A write is buffered in memory, deletes and copies run one object at a
 * time, and there is no `watch`, so clients poll. A failed move or overwrite can leave copies in the
 * target but never loses the source.
 *
 * @example
 * import { S3 } from '@aws-sdk/client-s3';
 * import { createFileHandler } from '@scope/server';
 *
 * const store = s3Store(new S3({ region: 'us-east-1' }), 'agent-files', 'tenant-a');
 * export const handler = createFileHandler({ store, authorize: async (req) => isSignedIn(req) });
 */
export function s3Store(client: S3Like, bucket: string, prefix = ''): FileStore {
  return new S3Store(client, bucket, prefix);
}
