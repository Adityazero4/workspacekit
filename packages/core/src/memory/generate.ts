function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic tree of `files` files, at most `depth` directories deep with up to `breadth` subdirectories
 * per level.
 * @internal — test/benchmark helper
 *
 * @example
 * ```ts
 * const files = generateTree({ files: 10_000, depth: 4, breadth: 20, seed: 7 });
 * ```
 */
export function generateTree(opts: {
  files: number;
  depth: number;
  breadth: number;
  seed?: number;
}): Record<string, string> {
  const random = mulberry32(opts.seed ?? 1);
  const out: Record<string, string> = {};
  for (let i = 0; i < opts.files; i++) {
    const dirs: string[] = [];
    for (let d = 0; d < opts.depth && random() < 0.75; d++) {
      dirs.push(`d${Math.floor(random() * opts.breadth)}`);
    }
    out[[...dirs, `f${i}.txt`].join('/')] = `file ${i}`;
  }
  return out;
}

/**
 * The benchmark tree layouts `generateShape` can build.
 * @internal — test/benchmark helper
 *
 * @example
 * ```ts
 * const shape: TreeShape = 'chains64';
 * ```
 */
export type TreeShape = 'wide' | '10x100k' | 'chains64';
const EXTS = ['txt', 'md', 'json', 'ts'];

/**
 * @internal — test/benchmark helper
 *
 * Deterministic benchmark tree of exactly `size` files (folders are implied by the paths):
 * `wide` puts them all in one folder, `10x100k` splits them across 10 folders, `chains64` spreads them across
 * the ends of 64-deep folder chains (one chain per 1000 files). `seed` only varies the file extensions.
 *
 * @example
 * ```ts
 * const adapter = createMemoryAdapter({ files: generateShape('wide', 100_000) });
 * ```
 */
export function generateShape(shape: TreeShape, size: number, seed = 1): Record<string, string> {
  const random = mulberry32(seed);
  const chains = Math.max(1, Math.ceil(size / 1000));
  const chainDir = (c: number): string => `c${c}/` + Array.from({ length: 63 }, (_, i) => `l${i}`).join('/');
  const dirs = shape === 'chains64' ? Array.from({ length: chains }, (_, c) => chainDir(c)) : [];
  const out: Record<string, string> = {};
  for (let i = 0; i < size; i++) {
    const dir = shape === 'wide' ? 'wide' : shape === '10x100k' ? `d${i % 10}` : dirs[i % chains]!;
    out[`${dir}/f${i}.${EXTS[Math.floor(random() * EXTS.length)]}`] = `file ${i}`;
  }
  return out;
}
