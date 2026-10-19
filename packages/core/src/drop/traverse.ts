import { mapWithConcurrency } from '../upload/pool';
import type { UploadItem } from '../upload/engine';

/**
 * The slice of FileSystemEntry / FileSystemDirectoryEntry we use (structural, so tests can pass plain fakes).
 *
 * @example
 * ```ts
 * const items = await expandDropped([{ entry: item.webkitGetAsEntry() as DropEntry }]);
 * ```
 */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(ok: (file: UploadItem['file']) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: DropEntry[]) => void, err: (e: unknown) => void): void };
}
/**
 * What a drop handler captured synchronously: an entry still to be walked, or a plain file.
 *
 * @example
 * ```ts
 * const dropped: DroppedItem[] = captureDataTransfer(event.dataTransfer);
 * ```
 */
export type DroppedItem = { entry: DropEntry } | UploadItem;

const OS_AND_TOOLING_JUNK = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'node_modules',
  '.git',
  '__pycache__',
]);
/**
 * Skips OS and tooling junk only; other dotfiles stay, because agent projects need them.
 *
 * @example
 * ```ts
 * DEFAULT_SKIP('node_modules'); // true
 * ```
 */
export const DEFAULT_SKIP: (name: string) => boolean = (name) => OS_AND_TOOLING_JUNK.has(name);

/**
 * Whether any segment of `relativePath` is skipped: folder segments are checked with `isDir` true, the last
 * one with `isDir` (default false, a file). So a file inside a skipped folder is skipped too.
 *
 * @example
 * ```ts
 * shouldSkipPath('node_modules/react/index.js'); // true
 * ```
 */
export function shouldSkipPath(
  relativePath: string,
  skip: (name: string, isDir: boolean) => boolean = DEFAULT_SKIP,
  isDir = false,
): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.some((segment, at) => skip(segment, at < segments.length - 1 || isDir));
}

const READS_IN_FLIGHT = 8;

/**
 * Call synchronously inside the drop handler: the entries are invalid once the handler returns. A top-level
 * file is captured as its `File` (some browsers cannot read a file entry made for a script-built
 * `DataTransfer`); only folders keep their entry, to be walked by `expandDropped`.
 *
 * @example
 * ```ts
 * onDrop={(event) => void upload(captureDataTransfer(event.dataTransfer))}
 * ```
 */
export function captureDataTransfer(dataTransfer: DataTransfer): DroppedItem[] {
  if (!dataTransfer.items) return fromFileList(dataTransfer.files);
  const captured: DroppedItem[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as DropEntry | null | undefined;
    const file = entry?.isDirectory ? null : item.getAsFile();
    if (file) captured.push({ file, relativePath: file.name });
    else if (entry) captured.push({ entry });
  }
  return captured;
}

/**
 * Upload items for the files of an `<input type="file">`, keeping folder paths from `webkitdirectory` inputs.
 *
 * @example
 * ```ts
 * const items = fromFileList(input.files!);
 * ```
 */
export function fromFileList(list: FileList | File[]): UploadItem[] {
  return Array.from(list, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

interface PendingFile {
  path: string;
  read(): Promise<UploadItem['file']>;
}

const pathOf = (entry: DropEntry): string => entry.fullPath.replace(/^\/+/, '');
const readNextBatch = (reader: DirectoryReader): Promise<DropEntry[]> =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

type DirectoryReader = ReturnType<NonNullable<DropEntry['createReader']>>;

async function readAllFiles(files: PendingFile[], skipped: string[]): Promise<UploadItem[]> {
  const settled = await mapWithConcurrency(files, READS_IN_FLIGHT, (file) => file.read());
  const read: UploadItem[] = [];
  settled.forEach((result, at) => {
    if (result.status === 'fulfilled') read.push({ file: result.value, relativePath: files[at]!.path });
    else skipped.push(files[at]!.path);
  });
  return read;
}

/**
 * Walks dropped folders into upload items, breadth-first with 8 directory reads in flight. Skipped and
 * unreadable entries are listed in `skipped`; walking stops once more than `maxFiles` (default 500) files are
 * found, and `overLimit` reports that.
 *
 * @example
 * ```ts
 * const { items, overLimit, skipped } = await expandDropped(captureDataTransfer(event.dataTransfer));
 * ```
 */
export async function expandDropped(
  items: DroppedItem[],
  opts: { maxFiles?: number; skip?: (name: string, isDir: boolean) => boolean } = {},
): Promise<{ items: UploadItem[]; overLimit: boolean; skipped: string[] }> {
  const maxFiles = opts.maxFiles ?? 500;
  const skip = opts.skip ?? DEFAULT_SKIP;
  const skipped: string[] = [];
  const files: PendingFile[] = [];
  const unreadDirectories: DropEntry[] = [];
  const pastLimit = (): boolean => files.length > maxFiles;

  const visit = (entry: DropEntry): void => {
    if (shouldSkipPath(pathOf(entry), skip, entry.isDirectory)) skipped.push(pathOf(entry));
    else if (entry.isDirectory) unreadDirectories.push(entry);
    else if (entry.isFile && entry.file) {
      const readFile = entry.file.bind(entry);
      files.push({
        path: pathOf(entry),
        read: () => new Promise((resolve, reject) => readFile(resolve, reject)),
      });
    }
  };
  const readDirectory = async (directory: DropEntry): Promise<void> => {
    const reader = directory.createReader?.();
    if (!reader) return void skipped.push(pathOf(directory));
    try {
      while (!pastLimit()) {
        const batch = await readNextBatch(reader);
        const directoryExhausted = batch.length === 0;
        if (directoryExhausted) break;
        batch.forEach(visit);
      }
    } catch {
      skipped.push(pathOf(directory));
    }
  };

  for (const item of items) {
    if ('entry' in item) visit(item.entry);
    else if (shouldSkipPath(item.relativePath, skip)) skipped.push(item.relativePath);
    else files.push({ path: item.relativePath, read: () => Promise.resolve(item.file) });
  }
  while (unreadDirectories.length > 0 && !pastLimit()) {
    const level = unreadDirectories.splice(0, READS_IN_FLIGHT);
    await mapWithConcurrency(level, READS_IN_FLIGHT, readDirectory);
  }
  const overLimit = pastLimit();
  return { items: await readAllFiles(files.slice(0, maxFiles), skipped), overLimit, skipped };
}
