import { expect, it } from 'vitest';
import { createMemoryAdapter, generateShape, generateTree } from '../src/memory';
import type { ChangeEvent } from '../src/types';
import { runAdapterContract } from './contract/adapter-contract';

runAdapterContract('memory', async () => ({
  adapter: createMemoryAdapter({ chunkSize: 4 }),
  cleanup: async () => {},
}));

it('seeds from options.files and applies latency', async () => {
  const fs = createMemoryAdapter({ files: { 'a/b.txt': 'hi', 'bin': new Uint8Array([1, 2]) }, latencyMs: 5 });
  expect(await fs.read('a/b.txt', 'text')).toBe('hi');
  expect((await fs.list('', { depth: 1 })).map((e) => e.path).sort()).toEqual(['a', 'bin']);
});

it('own mutations emit batches with actor user; emit passes external events through', async () => {
  const fs = createMemoryAdapter();
  const batches: ChangeEvent[][] = [];
  fs.watch!((b) => batches.push(b));
  await fs.write!('x/y.txt', 'v');
  expect(batches.flat().map((e) => [e.type, e.path, e.actor])).toEqual([
    ['created', 'x', 'user'],
    ['created', 'x/y.txt', 'user'],
  ]);
  expect(batches).toHaveLength(1);
  fs.emit([{ type: 'updated', path: 'x/y.txt', actor: 'external' }]);
  expect(batches[1]).toEqual([{ type: 'updated', path: 'x/y.txt', actor: 'external' }]);
});

it('mtime is strictly increasing even within one millisecond', async () => {
  const fs = createMemoryAdapter();
  const a = await fs.write!('f', '1');
  const b = await fs.write!('f', '2');
  expect(b.mtimeMs!).toBeGreaterThan(a.mtimeMs!);
});

it('generateTree is deterministic and respects its limits', () => {
  const opts = { files: 200, depth: 3, breadth: 4, seed: 7 };
  const t = generateTree(opts);
  expect(t).toEqual(generateTree(opts));
  expect(t).not.toEqual(generateTree({ ...opts, seed: 8 }));
  expect(Object.keys(t)).toHaveLength(200);
  for (const p of Object.keys(t)) expect(p.split('/').length).toBeLessThanOrEqual(4);
});

it('generateShape is deterministic and matches each shape', () => {
  const top = (files: Record<string, string>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of Object.keys(files)) m.set(p.split('/')[0]!, (m.get(p.split('/')[0]!) ?? 0) + 1);
    return m;
  };
  const wide = generateShape('wide', 1000);
  expect(Object.keys(wide)).toHaveLength(1000);
  expect(new Set(Object.keys(wide).map((p) => p.slice(0, p.lastIndexOf('/')))).size).toBe(1);

  const tenWays = generateShape('10x100k', 1000);
  expect(Object.keys(tenWays)).toHaveLength(1000);
  expect([...top(tenWays).values()]).toEqual(Array(10).fill(100));

  const chains = generateShape('chains64', 2500);
  expect(Object.keys(chains)).toHaveLength(2500);
  expect(new Set(Object.keys(chains).map((p) => p.split('/').length))).toEqual(new Set([65]));
  expect(top(chains).size).toBe(3); // 1000 files per chain end

  for (const shape of ['wide', '10x100k', 'chains64'] as const) {
    expect(generateShape(shape, 500, 7)).toEqual(generateShape(shape, 500, 7));
  }
  expect(generateShape('wide', 500, 1)).not.toEqual(generateShape('wide', 500, 2));
});
