import { isFsError } from '@workspacekit/core';
import { describe, expect, it } from 'vitest';
import { runStoreContract } from '../../../packages/server/test/support/store-contract';
import { createInMemoryS3 } from './inMemoryS3';
import { s3Store } from './s3Store';

const BUCKET = 'agent-files';

runStoreContract(
  's3Store',
  async () => ({ store: s3Store(createInMemoryS3(BUCKET), BUCKET), cleanup: async () => undefined }),
  { supportsWatch: false },
);

const bytesOf = async (body: ReadableStream<Uint8Array>): Promise<string> => new Response(body).text();

describe('s3Store against S3 specifics', () => {
  it('pages through a listing of more than 1,000 keys', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const store = s3Store(s3, BUCKET);
    for (let n = 0; n < 1001; n++) await store.write(`logs/line-${n}.txt`, new Uint8Array());
    const callsBefore = s3.listCallCount();
    expect(await store.list('logs', 1)).toHaveLength(1001);
    expect(s3.listCallCount() - callsBefore).toBeGreaterThanOrEqual(2);
  });

  it('keeps everything under the prefix and hides other prefixes', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const mine = s3Store(s3, BUCKET, 'tenant-a');
    const theirs = s3Store(s3, BUCKET, 'tenant-b');
    await mine.write('notes.md', new TextEncoder().encode('mine'));
    await theirs.write('notes.md', new TextEncoder().encode('theirs'));
    expect(s3.keys()).toEqual(['tenant-a/notes.md', 'tenant-b/notes.md']);
    expect((await mine.list('', 1)).map((entry) => entry.path)).toEqual(['notes.md']);
    expect(await bytesOf((await mine.read('notes.md')).body)).toBe('mine');
  });

  it('reads a byte range and reports the whole size', async () => {
    const store = s3Store(createInMemoryS3(BUCKET), BUCKET);
    await store.write('digits.txt', new TextEncoder().encode('0123456789'));
    const { body, size, entry } = await store.read('digits.txt', { start: 2, end: 99 });
    expect(await bytesOf(body)).toBe('23456789');
    expect(size).toBe(8);
    expect(entry.size).toBe(10);
  });

  it('refuses a range that starts past the end', async () => {
    const store = s3Store(createInMemoryS3(BUCKET), BUCKET);
    await store.write('short.txt', new TextEncoder().encode('abc'));
    const error = await store
      .read('short.txt', { start: 3, end: 4 })
      .catch((rejection: unknown) => rejection);
    expect(isFsError(error) && error.kind).toBe('invalid');
  });

  it('rejects a write over maxBytes without storing anything', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const store = s3Store(s3, BUCKET);
    const error = await store
      .write('big.bin', new Uint8Array(10), { maxBytes: 4 })
      .catch((rejection: unknown) => rejection);
    expect(isFsError(error) && error.kind).toBe('too_large');
    expect(s3.keys()).toEqual([]);
  });

  it('keeps an empty folder visible through its marker object', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const store = s3Store(s3, BUCKET);
    await store.create('empty', 'directory');
    expect(s3.keys()).toEqual(['empty/']);
    expect((await store.list('', 1)).map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:empty',
    ]);
  });
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function kindOf(pending: Promise<unknown>): Promise<unknown> {
  const error = await pending.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  return isFsError(error) ? error.kind : error;
}

describe('s3Store paging', () => {
  it('sends back each ContinuationToken it was given, in order, with a fixed page size', async () => {
    const s3 = createInMemoryS3(BUCKET, { pageSize: 7 });
    const store = s3Store(s3, BUCKET);
    for (let n = 0; n < 20; n++) await store.write(`dir/file-${String(n).padStart(2, '0')}.txt`, encode('x'));
    const names = (await store.list('dir', 1)).map((entry) => entry.name);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
    const tokens = s3.continuationTokens();
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokens).toEqual([...tokens].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('s3Store prefix isolation', () => {
  it('does not mix tenant-a with tenant-ab', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const tenantA = s3Store(s3, BUCKET, 'tenant-a');
    const tenantAb = s3Store(s3, BUCKET, 'tenant-ab');
    await tenantA.write('mine.txt', encode('a'));
    await tenantAb.write('theirs.txt', encode('ab'));
    expect((await tenantA.list('', 3)).map((entry) => entry.path)).toEqual(['mine.txt']);
    expect((await tenantA.search!('txt', 10)).map((entry) => entry.path)).toEqual(['mine.txt']);
    expect(await tenantA.stat('theirs.txt')).toBeNull();
  });

  it('refuses a path that climbs into a sibling prefix', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const tenantA = s3Store(s3, BUCKET, 'tenant-a');
    await s3Store(s3, BUCKET, 'tenant-b').write('secret.txt', encode('b'));
    expect(await kindOf(tenantA.read('../tenant-b/secret.txt'))).toBe('forbidden');
    expect(await kindOf(tenantA.copy('../tenant-b/secret.txt', 'stolen.txt'))).toBe('forbidden');
    expect(await kindOf(tenantA.write('../tenant-b/new.txt', encode('x')))).toBe('forbidden');
    expect(s3.keys()).toEqual(['tenant-b/secret.txt']);
  });

  it('treats a prefix of "/" as the bucket root', async () => {
    const s3 = createInMemoryS3(BUCKET);
    await s3Store(s3, BUCKET, '/').write('root.txt', encode('r'));
    expect(s3.keys()).toEqual(['root.txt']);
  });
});

describe('s3Store awkward keys', () => {
  it('copies and moves names containing %2F, spaces and unicode', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const store = s3Store(s3, BUCKET);
    const names = ['a%2Fb.txt', 'with space/%2F/c#1?.txt', 'résumé+100%.md'];
    for (const name of names) await store.write(name, encode(name));
    for (const name of names) {
      await store.copy(name, `copied/${name}`);
      expect(await bytesOf((await store.read(`copied/${name}`)).body)).toBe(name);
    }
    await store.move('copied', 'moved');
    for (const name of names) expect(await bytesOf((await store.read(`moved/${name}`)).body)).toBe(name);
    expect(await store.stat('copied')).toBeNull();
  });

  it('ignores keys with a leading slash or an empty segment, which no path can address', async () => {
    const s3 = createInMemoryS3(BUCKET);
    await s3.putObject({ Bucket: BUCKET, Key: '/hidden.txt', Body: encode('h') });
    await s3.putObject({ Bucket: BUCKET, Key: 'dir//double.txt', Body: encode('d') });
    await s3.putObject({ Bucket: BUCKET, Key: 'dir/fine.txt', Body: encode('f') });
    const store = s3Store(s3, BUCKET);
    expect((await store.list('', 1)).map((entry) => entry.path)).toEqual(['dir']);
    expect((await store.list('dir', 1)).map((entry) => entry.path)).toEqual(['dir/fine.txt']);
    expect((await store.search!('txt', 10)).map((entry) => entry.path)).toEqual(['dir/fine.txt']);
  });
});

describe('s3Store transfers', () => {
  it('keeps every source object when a copy fails halfway through a move', async () => {
    const s3 = createInMemoryS3(BUCKET);
    let copies = 0;
    const failingSecondCopy = {
      ...s3,
      copyObject: (input: Parameters<typeof s3.copyObject>[0]) => {
        if (++copies === 2) {
          return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalError' }));
        }
        return s3.copyObject(input);
      },
    };
    const store = s3Store(failingSecondCopy, BUCKET);
    await store.write('from/a.txt', encode('a'));
    await store.write('from/b.txt', encode('b'));
    await store.write('from/c.txt', encode('c'));
    expect(await kindOf(store.move('from', 'to'))).toBe('network');
    expect(s3.keys().filter((key) => key.startsWith('from/'))).toEqual([
      'from/a.txt',
      'from/b.txt',
      'from/c.txt',
    ]);
  });

  it('copies into an overwritten folder before deleting its leftovers', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const order: string[] = [];
    const recording = {
      ...s3,
      copyObject: (input: Parameters<typeof s3.copyObject>[0]) => {
        order.push(`copy ${input.Key}`);
        return s3.copyObject(input);
      },
      deleteObject: (input: Parameters<typeof s3.deleteObject>[0]) => {
        order.push(`delete ${input.Key}`);
        return s3.deleteObject(input);
      },
    };
    const store = s3Store(recording, BUCKET);
    await store.write('src/new.txt', encode('new'));
    await store.write('dst/old.txt', encode('old'));
    order.length = 0;
    await store.move('src', 'dst', { overwrite: true });
    expect(order).toEqual(['copy dst/new.txt', 'delete dst/old.txt', 'delete src/new.txt']);
    expect(s3.keys()).toEqual(['dst/new.txt']);
  });

  it('leaves the target untouched when the first copy of an overwrite fails', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const failing = {
      ...s3,
      copyObject: () => Promise.reject(Object.assign(new Error('x'), { name: 'SlowDown' })),
    };
    const store = s3Store(failing, BUCKET);
    await store.write('src/new.txt', encode('new'));
    await store.write('dst/old.txt', encode('old'));
    await kindOf(store.copy('src', 'dst', { overwrite: true }));
    expect(s3.keys()).toEqual(['dst/old.txt', 'src/new.txt']);
  });
});

describe('s3Store search', () => {
  it('stops listing once it has enough matches', async () => {
    const s3 = createInMemoryS3(BUCKET, { pageSize: 5 });
    const store = s3Store(s3, BUCKET);
    for (let n = 0; n < 30; n++) await store.write(`match-${String(n).padStart(2, '0')}.txt`, encode('x'));
    const callsBefore = s3.listCallCount();
    expect(await store.search!('match', 3)).toHaveLength(3);
    expect(s3.listCallCount() - callsBefore).toBe(1);
  });
});

describe('s3Store error mapping', () => {
  const failing = (name: string, httpStatusCode: number) => {
    const awsError = Object.assign(new Error('arn:aws:s3:::secret-bucket/private/key denied'), {
      name,
      $metadata: { httpStatusCode },
    });
    return { ...createInMemoryS3(BUCKET), listObjectsV2: () => Promise.reject(awsError) };
  };

  it.each([
    ['AccessDenied', 403, 'forbidden'],
    ['NoSuchBucket', 404, 'unknown'],
    ['SlowDown', 503, 'network'],
    ['InternalError', 500, 'network'],
    ['RequestTimeout', 400, 'timeout'],
    ['InvalidRange', 416, 'invalid'],
    ['PreconditionFailed', 412, 'conflict'],
    ['Strange', 418, 'unknown'],
  ])('%s (%i) becomes %s without the AWS message', async (name, status, kind) => {
    const store = s3Store(failing(name, status), BUCKET);
    const error = await store.stat('private/key').catch((rejection: unknown) => rejection);
    expect(isFsError(error) && error.kind).toBe(kind);
    expect((error as Error).message).not.toContain('secret-bucket');
    expect((error as Error).cause).toMatchObject({ name });
  });

  it('says to check the bucket when it does not exist', async () => {
    const error = await s3Store(failing('NoSuchBucket', 404), BUCKET)
      .stat('a')
      .catch((rejection: unknown) => rejection);
    expect((error as Error).message).toContain('check the bucket name');
  });
});

describe('s3Store conditional writes', () => {
  it('replaces a file only while expectedMtimeMs matches, even within one second', async () => {
    const s3 = createInMemoryS3(BUCKET, { secondResolution: true });
    const store = s3Store(s3, BUCKET);
    const first = await store.write('doc.txt', encode('v1'));
    const second = await store.write('doc.txt', encode('v2'), { expectedMtimeMs: first.mtimeMs! });
    expect(second.mtimeMs).toBe(first.mtimeMs);
    await store.write('doc.txt', encode('v3'), { expectedMtimeMs: second.mtimeMs! });
    expect(await bytesOf((await store.read('doc.txt')).body)).toBe('v3');
    expect(
      await kindOf(store.write('doc.txt', encode('v4'), { expectedMtimeMs: first.mtimeMs! - 1000 })),
    ).toBe('conflict');
    expect(await kindOf(store.write('missing.txt', encode('x'), { expectedMtimeMs: 1 }))).toBe('conflict');
  });

  it('refuses the write when someone else replaced the file between our read and our put', async () => {
    const s3 = createInMemoryS3(BUCKET, { secondResolution: true });
    let interfere = false;
    const racing = {
      ...s3,
      putObject: async (input: Parameters<typeof s3.putObject>[0]) => {
        if (interfere) {
          interfere = false;
          await s3.putObject({
            ...input,
            Body: encode('theirs'),
            IfMatch: undefined,
            IfNoneMatch: undefined,
          });
        }
        return s3.putObject(input);
      },
    };
    const store = s3Store(racing, BUCKET);
    const first = await store.write('doc.txt', encode('v1'));
    interfere = true;
    expect(await kindOf(store.write('doc.txt', encode('mine'), { expectedMtimeMs: first.mtimeMs! }))).toBe(
      'conflict',
    );
    expect(await bytesOf((await store.read('doc.txt')).body)).toBe('theirs');
  });

  it('refuses overwrite:false when the file appears between our read and our put', async () => {
    const s3 = createInMemoryS3(BUCKET);
    const racing = {
      ...s3,
      putObject: async (input: Parameters<typeof s3.putObject>[0]) => {
        await s3.putObject({ ...input, Body: encode('theirs'), IfNoneMatch: undefined });
        return s3.putObject(input);
      },
    };
    const store = s3Store(racing, BUCKET);
    expect(await kindOf(store.write('new.txt', encode('mine'), { overwrite: false }))).toBe('conflict');
  });
});
