import { describe, expect, it } from 'vitest';
import {
  captureDataTransfer,
  DEFAULT_SKIP,
  expandDropped,
  fromFileList,
  shouldSkipPath,
  type DropEntry,
} from '../src/drop/traverse';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const mkFile = (name: string): File => new File(['x'], name);

interface Stats {
  reads: number;
  inflight: number;
  peak: number;
}
const stats = (): Stats => ({ reads: 0, inflight: 0, peak: 0 });

function fileEntry(name: string, fullPath: string, fail = false): DropEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (ok: (f: File) => void, err: (e: unknown) => void) =>
      fail ? err(new Error('nope')) : ok(mkFile(name)),
  };
}
/** readEntries hands out batches of 100 until empty. */
function dirEntry(
  name: string,
  fullPath: string,
  children: DropEntry[],
  s: Stats = stats(),
  fail = false,
): DropEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader() {
      let pos = 0;
      return {
        readEntries(ok: (e: DropEntry[]) => void, err: (e: unknown) => void) {
          s.reads++;
          if (fail) return err(new Error('nope'));
          s.inflight++;
          s.peak = Math.max(s.peak, s.inflight);
          const batch = children.slice(pos, pos + 100);
          pos += 100;
          void tick().then(() => {
            s.inflight--;
            ok(batch);
          });
        },
      };
    },
  };
}
const files = (n: number, dir: string): DropEntry[] =>
  Array.from({ length: n }, (_, i) => fileEntry(`f${i}.txt`, `/${dir}/f${i}.txt`));

describe('expandDropped', () => {
  it('drains readEntries batches', async () => {
    const r = await expandDropped([{ entry: dirEntry('proj', '/proj', files(250, 'proj')) }]);
    expect(r.items).toHaveLength(250);
    expect(r.overLimit).toBe(false);
  });

  it('relativePath keeps the dropped folder name', async () => {
    const src = dirEntry('src', '/proj/src', [fileEntry('a.ts', '/proj/src/a.ts')]);
    const r = await expandDropped([{ entry: dirEntry('proj', '/proj', [src]) }]);
    expect(r.items.map((i) => i.relativePath)).toEqual(['proj/src/a.ts']);
    expect(r.items[0]!.file.name).toBe('a.ts');
  });

  it('handles a dropped single file', async () => {
    const r = await expandDropped([{ entry: fileEntry('a.txt', '/a.txt') }]);
    expect(r.items.map((i) => i.relativePath)).toEqual(['a.txt']);
  });

  it('stops at maxFiles+1 and reports overLimit without walking the whole tree', async () => {
    const s = stats();
    const r = await expandDropped([{ entry: dirEntry('big', '/big', files(1000, 'big'), s) }], {
      maxFiles: 150,
    });
    expect(r.overLimit).toBe(true);
    expect(r.items).toHaveLength(150);
    expect(s.reads).toBe(2); // 100 + 100 >= 151, never reads batches 3..11
  });

  it('exactly maxFiles is not overLimit', async () => {
    const r = await expandDropped([{ entry: dirEntry('d', '/d', files(5, 'd')) }], { maxFiles: 5 });
    expect(r.overLimit).toBe(false);
    expect(r.items).toHaveLength(5);
  });

  it('skips DEFAULT_SKIP names and reports them in skipped', async () => {
    const nm = dirEntry('node_modules', '/p/node_modules', [fileEntry('x.js', '/p/node_modules/x.js')]);
    const root = dirEntry('p', '/p', [
      nm,
      fileEntry('.DS_Store', '/p/.DS_Store'),
      fileEntry('.env.example', '/p/.env.example'),
    ]);
    const r = await expandDropped([{ entry: root }]);
    expect(r.items.map((i) => i.relativePath)).toEqual(['p/.env.example']);
    expect(r.skipped.sort()).toEqual(['p/.DS_Store', 'p/node_modules']);
    for (const n of ['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '.git', '__pycache__']) {
      expect(DEFAULT_SKIP(n)).toBe(true);
    }
    expect(DEFAULT_SKIP('.env.example')).toBe(false);
  });

  it('honours a custom skip(name, isDir)', async () => {
    const root = dirEntry('p', '/p', [fileEntry('a.log', '/p/a.log'), fileEntry('b.txt', '/p/b.txt')]);
    const r = await expandDropped([{ entry: root }], { skip: (n, isDir) => !isDir && n.endsWith('.log') });
    expect(r.items.map((i) => i.relativePath)).toEqual(['p/b.txt']);
  });

  it('directory reads run at most 8 at a time', async () => {
    const s = stats();
    const dirs = Array.from({ length: 20 }, (_, i) => dirEntry(`d${i}`, `/r/d${i}`, files(2, `r/d${i}`), s));
    const r = await expandDropped([{ entry: dirEntry('r', '/r', dirs, s) }]);
    expect(r.items).toHaveLength(40);
    expect(s.peak).toBeGreaterThan(1);
    expect(s.peak).toBeLessThanOrEqual(8);
  });

  it('reports unreadable files and directories instead of throwing', async () => {
    const bad = dirEntry('bad', '/p/bad', [], stats(), true);
    const root = dirEntry('p', '/p', [bad, fileEntry('x', '/p/x', true), fileEntry('ok', '/p/ok')]);
    const r = await expandDropped([{ entry: root }]);
    expect(r.items.map((i) => i.relativePath)).toEqual(['p/ok']);
    expect(r.skipped.sort()).toEqual(['p/bad', 'p/x']);
  });

  it('passes through plain files from the fallback path', async () => {
    const f = mkFile('a.txt');
    const r = await expandDropped([{ file: f, relativePath: 'a.txt' }]);
    expect(r.items).toEqual([{ file: f, relativePath: 'a.txt' }]);
  });
});

describe('shouldSkipPath', () => {
  it('skips a FileList file under a skipped folder, not only a skipped file name', async () => {
    const withPath = (p: string): File => {
      const f = mkFile(p.split('/').pop()!);
      Object.defineProperty(f, 'webkitRelativePath', { value: p });
      return f;
    };
    const list = ['proj/node_modules/x.js', 'proj/.git/config', 'proj/src/a.ts'].map(withPath);
    const r = await expandDropped(fromFileList(list));
    expect(r.items.map((i) => i.relativePath)).toEqual(['proj/src/a.ts']);
    expect(r.skipped.sort()).toEqual(['proj/.git/config', 'proj/node_modules/x.js']);
  });

  it('checks folder segments as directories and the last one as a file', () => {
    const seen: [string, boolean][] = [];
    expect(shouldSkipPath('a/b/c.txt', (n, d) => (seen.push([n, d]), false))).toBe(false);
    expect(seen).toEqual([
      ['a', true],
      ['b', true],
      ['c.txt', false],
    ]);
    expect(shouldSkipPath('p/.DS_Store')).toBe(true);
    expect(shouldSkipPath('p/node_modules', (n, d) => d && n === 'node_modules')).toBe(false);
  });
});

describe('fromFileList', () => {
  it('uses webkitRelativePath when present, else the name', () => {
    const a = Object.assign(mkFile('a.ts'), {});
    const b = mkFile('b.ts');
    Object.defineProperty(b, 'webkitRelativePath', { value: 'proj/b.ts' });
    expect(fromFileList([a, b]).map((i) => i.relativePath)).toEqual(['a.ts', 'proj/b.ts']);
  });
});

describe('captureDataTransfer', () => {
  it('captures a folder as its entry, synchronously via webkitGetAsEntry', () => {
    const e = dirEntry('a', '/a', []);
    const dt = {
      items: [{ kind: 'file', webkitGetAsEntry: () => e, getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(captureDataTransfer(dt)).toEqual([{ entry: e }]);
  });

  it('falls back to getAsFile when there is no entry, and to dt.files without items', () => {
    const f = mkFile('a');
    const viaItem = {
      items: [{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => f }],
      files: [],
    } as unknown as DataTransfer;
    expect(captureDataTransfer(viaItem)).toEqual([{ file: f, relativePath: 'a' }]);
    const viaFiles = { files: [f] } as unknown as DataTransfer;
    expect(captureDataTransfer(viaFiles)).toEqual([{ file: f, relativePath: 'a' }]);
  });

  it('captures a top-level file as its File, keeping the entry only for folders', () => {
    const f = mkFile('a');
    const folder = dirEntry('d', '/d', []);
    const dt = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => fileEntry('a', '/a', true), getAsFile: () => f },
        { kind: 'file', webkitGetAsEntry: () => folder, getAsFile: () => mkFile('d') },
      ],
      files: [],
    } as unknown as DataTransfer;
    expect(captureDataTransfer(dt)).toEqual([{ file: f, relativePath: 'a' }, { entry: folder }]);
  });
});
