'use client';
import { FsError, parentPath, type Entry, type FileSystemAdapter } from '@scope/core';
import type { Action, ActionContext } from './actions';
import { pasteInto } from './clipboard';

/**
 * The ids of the built-in actions, in menu order; `canPerform` receives them (and custom action ids).
 *
 * @example
 * ```ts
 * BUILTIN_ACTION_IDS.includes('delete'); // true
 * ```
 */
export const BUILTIN_ACTION_IDS: readonly [
  'open',
  'newFile',
  'newFolder',
  'rename',
  'duplicate',
  'delete',
  'cut',
  'copy',
  'paste',
  'copyPath',
  'download',
  'uploadFiles',
  'uploadFolder',
] = [
  'open',
  'newFile',
  'newFolder',
  'rename',
  'duplicate',
  'delete',
  'cut',
  'copy',
  'paste',
  'copyPath',
  'download',
  'uploadFiles',
  'uploadFolder',
];

type BuiltinActionId = (typeof BUILTIN_ACTION_IDS)[number];

interface BuiltinAction extends Action {
  id: BuiltinActionId;
  isSupportedBy: (adapter: FileSystemAdapter) => boolean;
}

const DOWNLOAD_URL_LIFETIME_MS = 40_000;

const always = (): boolean => true;
const folderOf = (entry: Entry): string => (entry.kind === 'directory' ? entry.path : parentPath(entry.path));

async function confirmAndDelete(entry: Entry, context: ActionContext): Promise<void> {
  const confirmed = await context.confirm({
    title: `Delete "${entry.name}"?`,
    description:
      entry.kind === 'directory'
        ? 'The folder and everything in it will be deleted. This cannot be undone.'
        : 'The file will be deleted. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (confirmed) await context.fs.store.remove(entry.path);
}

async function copyPath(entry: Entry, { fs }: ActionContext): Promise<void> {
  await navigator.clipboard.writeText(entry.path);
  fs.notify({ kind: 'success', message: `Copied the path of "${entry.name}".` });
}

function clickDownloadLink(href: string, fileName: string, opensElsewhere: boolean): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  if (opensElsewhere) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  document.body.append(link);
  link.click();
  link.remove();
}

const DOWNLOADABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'blob:']);

function parsedUrlOrNull(url: string): URL | null {
  try {
    return new URL(url, location.href);
  } catch {
    return null;
  }
}

function safeDownloadUrl(url: string): string {
  const parsed = parsedUrlOrNull(url);
  if (!parsed || !DOWNLOADABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new FsError(
      'invalid',
      `the adapter returned the download URL "${url}", which is not an http, https or blob URL; return one of those`,
    );
  }
  return parsed.href;
}

async function download(entry: Entry, { fs }: ActionContext): Promise<void> {
  const result = await fs.adapter.download!([entry.path]);
  if (!(result instanceof Blob)) {
    clickDownloadLink(safeDownloadUrl(result.url), result.fileName ?? entry.name, true);
    return;
  }
  const url = URL.createObjectURL(result);
  clickDownloadLink(url, entry.kind === 'directory' ? `${entry.name}.zip` : entry.name, false);
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

const clipboardOpIsSupported = (_entry: Entry, { fs }: ActionContext): boolean => {
  const item = fs.clipboard.get();
  if (!item) return false;
  return item.op === 'cut' ? fs.adapter.move !== undefined : fs.adapter.copy !== undefined;
};

const BUILTIN_ACTIONS: readonly BuiltinAction[] = [
  {
    id: 'open',
    label: 'Open',
    group: 'open',
    isSupportedBy: always,
    when: (entry) => entry.kind === 'file',
    run: (entry, { tree }) => tree.open(entry),
  },
  {
    id: 'newFile',
    label: 'New file…',
    group: 'create',
    isSupportedBy: (adapter) => adapter.create !== undefined,
    run: (entry, context) => context.openCreate('file', folderOf(entry)),
  },
  {
    id: 'newFolder',
    label: 'New folder…',
    group: 'create',
    isSupportedBy: (adapter) => adapter.create !== undefined,
    run: (entry, context) => context.openCreate('directory', folderOf(entry)),
  },
  {
    id: 'rename',
    label: 'Rename',
    group: 'edit',
    shortcut: 'F2',
    isSupportedBy: (adapter) => adapter.move !== undefined,
    run: (entry, context) => context.startRename(entry.path),
  },
  {
    id: 'duplicate',
    label: 'Duplicate',
    group: 'edit',
    isSupportedBy: (adapter) => adapter.copy !== undefined,
    run: async (entry, { fs }) => void (await fs.store.duplicate(entry.path)),
  },
  {
    id: 'delete',
    label: 'Delete…',
    group: 'edit',
    shortcut: 'Delete',
    danger: true,
    isSupportedBy: (adapter) => adapter.delete !== undefined,
    run: confirmAndDelete,
  },
  {
    id: 'cut',
    label: 'Cut',
    group: 'clipboard',
    shortcut: 'Mod+X',
    isSupportedBy: (adapter) => adapter.move !== undefined,
    run: (entry, { fs }) => fs.clipboard.set({ op: 'cut', path: entry.path }),
  },
  {
    id: 'copy',
    label: 'Copy',
    group: 'clipboard',
    shortcut: 'Mod+C',
    isSupportedBy: (adapter) => adapter.copy !== undefined,
    run: (entry, { fs }) => fs.clipboard.set({ op: 'copy', path: entry.path }),
  },
  {
    id: 'paste',
    label: 'Paste',
    group: 'clipboard',
    shortcut: 'Mod+V',
    isSupportedBy: (adapter) => adapter.move !== undefined || adapter.copy !== undefined,
    when: clipboardOpIsSupported,
    run: (entry, { fs }) => pasteInto(fs, folderOf(entry)),
  },
  { id: 'copyPath', label: 'Copy path', group: 'clipboard', isSupportedBy: always, run: copyPath },
  {
    id: 'download',
    label: 'Download',
    group: 'transfer',
    isSupportedBy: (adapter) => adapter.download !== undefined,
    run: download,
  },
  {
    id: 'uploadFiles',
    label: 'Upload files…',
    group: 'transfer',
    isSupportedBy: (adapter) => adapter.upload !== undefined,
    run: (entry, context) => context.pickUploads('files', folderOf(entry)),
  },
  {
    id: 'uploadFolder',
    label: 'Upload folder…',
    group: 'transfer',
    isSupportedBy: (adapter) => adapter.upload !== undefined,
    run: (entry, context) => context.pickUploads('folder', folderOf(entry)),
  },
];

/**
 * The built-in actions this adapter supports: create gives New file and New folder, move gives Rename and
 * Cut, copy gives Duplicate and Copy, delete gives Delete, download gives Download, upload gives Upload files
 * and Upload folder (into the entry's folder); Open and Copy path are always there. Paste shows while the
 * clipboard holds an entry the adapter can move or copy.
 *
 * @example
 * ```tsx
 * const actions = [...builtinActions(adapter), askTheAgent];
 * ```
 */
export function builtinActions(adapter: FileSystemAdapter): Action[] {
  return BUILTIN_ACTIONS.filter((action) => action.isSupportedBy(adapter)).map(
    ({ isSupportedBy, ...action }) => action,
  );
}
