import type { S3Like } from './s3Store';

interface StoredObject {
  bytes: Uint8Array;
  lastModified: Date;
  etag: string;
}

/**
 * Options of `createInMemoryS3`: `pageSize` is the fixed number of entries a listing page holds (S3's is
 * 1,000), and `secondResolution` truncates `LastModified` to whole seconds like real S3.
 *
 * @example
 * const s3 = createInMemoryS3('agent-files', { pageSize: 7, secondResolution: true });
 */
export interface InMemoryS3Options {
  pageSize?: number;
  secondResolution?: boolean;
}

/**
 * An `S3Like` that keeps objects in a `Map` and behaves like S3 where `s3Store` depends on it: listings
 * are sorted, capped at 1,000 entries per page and continued with a token, `Delimiter` groups keys into
 * `CommonPrefixes`, a missing key throws `NoSuchKey`, and `IfNoneMatch: '*'` refuses to replace a key.
 *
 * @example
 * const s3 = createInMemoryS3();
 * const store = s3Store(s3, 'agent-files');
 */
export interface InMemoryS3 extends S3Like {
  /** How many `listObjectsV2` calls were made, to show that a long listing was paged. */
  listCallCount(): number;
  /** Every stored key in the order S3 lists them. */
  keys(): string[];
  /** The `ContinuationToken` of every `listObjectsV2` call that carried one. */
  continuationTokens(): string[];
}

const PAGE_LIMIT = 1000;

function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function groupByDelimiter(
  keys: string[],
  prefix: string,
  delimiter: string | undefined,
): Array<{ sortKey: string; key?: string; commonPrefix?: string }> {
  const groups = new Map<string, { sortKey: string; key?: string; commonPrefix?: string }>();
  for (const key of keys) {
    const delimiterAt = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
    if (delimiterAt === -1) groups.set(key, { sortKey: key, key });
    else {
      const commonPrefix = key.slice(0, delimiterAt + 1);
      groups.set(commonPrefix, { sortKey: commonPrefix, commonPrefix });
    }
  }
  return [...groups.values()];
}

function parseRange(range: string, size: number): { start: number; end: number } {
  const [, startText, endText] = /^bytes=(\d+)-(\d*)$/.exec(range) ?? [];
  const start = Number(startText);
  const end = Math.min(endText ? Number(endText) : size - 1, size - 1);
  if (startText === undefined || start >= size) throw s3Error('InvalidRange', 416);
  return { start, end };
}

/**
 * Creates an empty in-memory bucket named `bucket`; any other bucket name throws `NoSuchBucket`.
 *
 * @example
 * const s3 = createInMemoryS3('agent-files');
 */
export function createInMemoryS3(bucket = 'agent-files', options: InMemoryS3Options = {}): InMemoryS3 {
  const { pageSize = PAGE_LIMIT, secondResolution = false } = options;
  const objects = new Map<string, StoredObject>();
  const tokens: string[] = [];
  let listCalls = 0;
  let versions = 0;
  const checkBucket = (requested: string): void => {
    if (requested !== bucket) throw s3Error('NoSuchBucket', 404);
  };
  const objectAt = (key: string): StoredObject => {
    const found = objects.get(key);
    if (!found) throw s3Error('NoSuchKey', 404);
    return found;
  };
  const store = (key: string, bytes: Uint8Array): void => {
    const now = Date.now();
    const lastModified = new Date(secondResolution ? Math.floor(now / 1000) * 1000 : now);
    objects.set(key, { bytes: bytes.slice(), lastModified, etag: `"v${++versions}"` });
  };
  return {
    listCallCount: () => listCalls,
    keys: () => [...objects.keys()].sort(),
    continuationTokens: () => [...tokens],
    async getObject({ Bucket, Key, Range }) {
      checkBucket(Bucket);
      const { bytes, lastModified, etag } = objectAt(Key);
      const { start, end } = Range ? parseRange(Range, bytes.length) : { start: 0, end: bytes.length - 1 };
      const body = bytes.slice(start, end + 1);
      return {
        Body: { transformToWebStream: () => new Blob([body]).stream() },
        ContentLength: body.length,
        ETag: etag,
        LastModified: lastModified,
      };
    },
    async putObject({ Bucket, Key, Body, IfNoneMatch, IfMatch }) {
      checkBucket(Bucket);
      if (IfMatch !== undefined && objectAt(Key).etag !== IfMatch) throw s3Error('PreconditionFailed', 412);
      if (IfNoneMatch === '*' && objects.has(Key)) throw s3Error('PreconditionFailed', 412);
      store(Key, Body);
      return {};
    },
    async deleteObject({ Bucket, Key }) {
      checkBucket(Bucket);
      objects.delete(Key);
      return {};
    },
    async copyObject({ Bucket, Key, CopySource }) {
      checkBucket(Bucket);
      const separatorAt = CopySource.indexOf('/');
      checkBucket(CopySource.slice(0, separatorAt));
      store(Key, objectAt(decodeURIComponent(CopySource.slice(separatorAt + 1))).bytes);
      return {};
    },
    async listObjectsV2({ Bucket, Prefix = '', Delimiter, ContinuationToken, MaxKeys = pageSize }) {
      checkBucket(Bucket);
      listCalls++;
      if (ContinuationToken !== undefined) tokens.push(ContinuationToken);
      const matching = [...objects.keys()].filter((key) => key.startsWith(Prefix));
      const items = groupByDelimiter(matching, Prefix, Delimiter)
        .filter((item) => ContinuationToken === undefined || item.sortKey > ContinuationToken)
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
      const page = items.slice(0, Math.min(MaxKeys, pageSize));
      const isTruncated = items.length > page.length;
      return {
        Contents: page.flatMap((item) => {
          if (item.key === undefined) return [];
          const { bytes, lastModified, etag } = objectAt(item.key);
          return [{ Key: item.key, ETag: etag, Size: bytes.length, LastModified: lastModified }];
        }),
        CommonPrefixes: page.flatMap((item) => (item.commonPrefix ? [{ Prefix: item.commonPrefix }] : [])),
        IsTruncated: isTruncated,
        NextContinuationToken: isTruncated ? page[page.length - 1]?.sortKey : undefined,
      };
    },
  };
}
