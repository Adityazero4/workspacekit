import { isFsError } from '@workspacekit/core';
import { httpAdapter } from '@workspacekit/core/http';
import { describe, expect, it } from 'vitest';
import { runAdapterContract } from '../../../core/test/contract/adapter-contract';
import { createFileHandler, type FileStore } from '../../src';

/**
 * A store under test and the cleanup that discards what the test wrote.
 *
 * @example
 * const made: MadeStore = { store: nodeFsStore(dir), cleanup: () => rm(dir, { recursive: true }) };
 */
export interface MadeStore {
  store: FileStore;
  cleanup(): Promise<void>;
}

/**
 * Options of `runStoreContract`: set `supportsWatch` to false for a store without `watch`.
 *
 * @example
 * runStoreContract('s3Store', makeS3Store, { supportsWatch: false });
 */
export interface StoreContractOptions {
  supportsWatch?: boolean;
}

const MANY_FILES = 1050;
const MANY_FILES_TIMEOUT_MS = 60_000;

const bytesOf = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());

async function errorKindOf(pending: Promise<unknown>): Promise<unknown> {
  const error = await pending.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  return isFsError(error) ? error.kind : error;
}

function describeStoreBehaviour(name: string, make: () => Promise<MadeStore>): void {
  describe(`store contract: ${name}`, () => {
    it(
      'lists every entry of a folder holding more than 1,000 files',
      async () => {
        const { store, cleanup } = await make();
        try {
          for (let n = 0; n < MANY_FILES; n++) {
            await store.write(`many/file-${n}.txt`, new Uint8Array([n % 256]));
          }
          const names = (await store.list('many', 1)).map((entry) => entry.name);
          expect(names).toHaveLength(MANY_FILES);
          expect(new Set(names).size).toBe(MANY_FILES);
        } finally {
          await cleanup();
        }
      },
      MANY_FILES_TIMEOUT_MS,
    );

    it('refuses a path that climbs out of the root', async () => {
      const { store, cleanup } = await make();
      try {
        await store.write('inside.txt', new Uint8Array([1]));
        expect(await errorKindOf(store.read('../outside.txt'))).toBe('forbidden');
        expect(await errorKindOf(store.write('a/../../outside.txt', new Uint8Array([1])))).toBe('forbidden');
        expect(await errorKindOf(store.move('inside.txt', '../outside.txt'))).toBe('forbidden');
      } finally {
        await cleanup();
      }
    });

    it('keeps the bytes of every file when a folder moves', async () => {
      const { store, cleanup } = await make();
      try {
        const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
        await store.write('from/a.bin', binary);
        await store.write('from/deep/b.bin', new Uint8Array([9, 8, 7]));
        await store.move('from', 'to');
        expect(await bytesOf((await store.read('to/a.bin')).body)).toEqual(binary);
        expect(await bytesOf((await store.read('to/deep/b.bin')).body)).toEqual(new Uint8Array([9, 8, 7]));
        expect(await store.stat('from')).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });
}

/**
 * Runs the adapter contract through `createFileHandler` and `httpAdapter` against a store, then the
 * store-level checks (pagination past 1,000 files, refusing path traversal, moves keeping content).
 *
 * @example
 * runStoreContract('nodeFsStore', async () => {
 *   const dir = await mkdtemp(join(tmpdir(), 'fs-contract-'));
 *   return { store: nodeFsStore(dir), cleanup: () => rm(dir, { recursive: true }) };
 * });
 */
export function runStoreContract(
  name: string,
  make: () => Promise<MadeStore>,
  options: StoreContractOptions = {},
): void {
  runAdapterContract(
    `http + server + ${name}`,
    async () => {
      const { store, cleanup } = await make();
      const handler = createFileHandler({ store, authorize: () => true, chunkSize: 4 });
      return {
        adapter: httpAdapter('http://t/api/files', {
          fetch: (input, init) => handler(new Request(input, init)),
        }),
        cleanup,
      };
    },
    options,
  );
  describeStoreBehaviour(name, make);
}
