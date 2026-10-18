import { mapWithConcurrency } from '../upload/pool';
import type { UploadItem } from '../upload/engine';

/** The slice of FileSystemEntry / FileSystemDirectoryEntry we use (structural, so tests can pass plain fakes). */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(ok: (file: UploadItem['file']) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: DropEntry[]) => void, err: (e: unknown) => void): void };
}
/** What a drop handler captured synchronously: an entry still to be walked, or a plain file. */
export type DroppedItem = { entry: DropEntry } | UploadItem;

const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '.git', '__pycache__']);
// ponytail: only OS/tooling junk; other dotfiles stay because agent projects need them.
export const DEFAULT_SKIP: (name: string) => boolean = (name) => SKIP_NAMES.has(name);

/**
 * Whether any segment of `relativePath` is skipped: folder segments are checked with `isDir` true, the last one
 * with `isDir` (default false, a file). So a file inside a skipped folder is skipped too.
 */
export function shouldSkipPath(
  relativePath: string,
  skip: (name: string, isDir: boolean) => boolean = DEFAULT_SKIP,
  isDir = false,
): boolean {
  const segs = relativePath.split('/').filter(Boolean);
  return segs.some((s, i) => skip(s, i < segs.length - 1 || isDir));
}

const DIR_CONCURRENCY = 8;

/** Call synchronously inside the drop handler: the entries are invalid once the handler returns. */
export function captureDataTransfer(dt: DataTransfer): DroppedItem[] {
  const out: DroppedItem[] = [];
  if (dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry?.() as DropEntry | null | undefined;
      if (entry) out.push({ entry });
      else {
        const file = it.getAsFile();
        if (file) out.push({ file, relativePath: file.name });
      }
    }
    return out;
  }
  return fromFileList(dt.files);
}

export function fromFileList(list: FileList | File[]): UploadItem[] {
  return Array.from(list, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

interface Pending {
  path: string;
  get(): Promise<UploadItem['file']>;
}

export async function expandDropped(
  items: DroppedItem[],
  opts: { maxFiles?: number; skip?: (name: string, isDir: boolean) => boolean } = {},
): Promise<{ items: UploadItem[]; overLimit: boolean; skipped: string[] }> {
  const maxFiles = opts.maxFiles ?? 500;
  const skip = opts.skip ?? DEFAULT_SKIP;
  const skipped: string[] = [];
  const pending: Pending[] = [];
  const dirs: DropEntry[] = [];
  const over = (): boolean => pending.length > maxFiles;
  const pathOf = (e: DropEntry): string => e.fullPath.replace(/^\/+/, '');

  const visit = (e: DropEntry): void => {
    if (shouldSkipPath(pathOf(e), skip, e.isDirectory)) skipped.push(pathOf(e));
    else if (e.isDirectory) dirs.push(e);
    else if (e.isFile && e.file) {
      const read = e.file.bind(e);
      pending.push({ path: pathOf(e), get: () => new Promise((ok, err) => read(ok, err)) });
    }
  };
  const readDir = async (dir: DropEntry): Promise<void> => {
    const reader = dir.createReader?.();
    if (!reader) return void skipped.push(pathOf(dir));
    try {
      // readEntries returns at most ~100 per call; an empty batch means done.
      while (!over()) {
        const batch = await new Promise<DropEntry[]>((ok, err) => reader.readEntries(ok, err));
        if (batch.length === 0) break;
        batch.forEach(visit);
      }
    } catch {
      skipped.push(pathOf(dir));
    }
  };

  for (const it of items) {
    if ('entry' in it) visit(it.entry);
    else if (shouldSkipPath(it.relativePath, skip)) skipped.push(it.relativePath);
    else pending.push({ path: it.relativePath, get: () => Promise.resolve(it.file) });
  }
  // Breadth-first, 8 directory reads in flight; stop once one file past the limit is known.
  while (dirs.length > 0 && !over()) {
    await mapWithConcurrency(dirs.splice(0, DIR_CONCURRENCY), DIR_CONCURRENCY, readDir);
  }

  const overLimit = over();
  const kept = pending.slice(0, maxFiles);
  const settled = await mapWithConcurrency(kept, DIR_CONCURRENCY, (p) => p.get());
  const out: UploadItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push({ file: r.value, relativePath: kept[i]!.path });
    else skipped.push(kept[i]!.path);
  });
  return { items: out, overLimit, skipped };
}
