import type { Entry, FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { expect, test, vi } from 'vitest';
import type { ActionContext } from '../src/actions/actions';
import { BUILTIN_ACTION_IDS, builtinActions } from '../src/actions/builtin';
import { createUiStore } from '../src/provider/ui-store';

const memory = createMemoryAdapter({ files: { 'a.txt': '' } });
const readOnly: FileSystemAdapter = { list: memory.list, read: memory.read };
const ids = (adapter: FileSystemAdapter): string[] => builtinActions(adapter).map((action) => action.id);
const file: Entry = { path: 'a.txt', name: 'a.txt', kind: 'file' };

test('builtinActions follows adapter capabilities', () => {
  expect(ids(readOnly)).toEqual(['open', 'copyPath']);
  expect(ids({ ...readOnly, download: memory.download })).toEqual(['open', 'copyPath', 'download']);
  expect(ids({ ...readOnly, move: memory.move })).toEqual(['open', 'rename', 'cut', 'paste', 'copyPath']);
  expect(ids({ ...readOnly, create: memory.create })).toEqual(['open', 'newFile', 'newFolder', 'copyPath']);
  expect(ids(memory)).toEqual([
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
  ]);
  expect(ids({ ...readOnly, upload: memory.upload })).toEqual([
    'open',
    'copyPath',
    'uploadFiles',
    'uploadFolder',
  ]);
});

test('every built-in action id is listed in BUILTIN_ACTION_IDS', () => {
  for (const id of ids(memory)) expect(BUILTIN_ACTION_IDS).toContain(id);
});

test('rename starts the inline rename; paste needs a clipboard entry the adapter can transfer', () => {
  const startRename = vi.fn();
  const clipboard = createUiStore<{ op: 'cut' | 'copy'; path: string } | null>(null);
  const adapter: FileSystemAdapter = { ...readOnly, move: memory.move };
  const context = { entry: file, startRename, fs: { adapter, clipboard } } as unknown as ActionContext;
  const byId = new Map(builtinActions(adapter).map((action) => [action.id, action]));

  void byId.get('rename')!.run(file, context);
  expect(startRename).toHaveBeenCalledWith('a.txt');

  const paste = byId.get('paste')!;
  expect(paste.when!(file, context), 'empty clipboard').toBe(false);
  clipboard.set({ op: 'cut', path: 'b.txt' });
  expect(paste.when!(file, context), 'a cut, and the adapter can move').toBe(true);
  clipboard.set({ op: 'copy', path: 'b.txt' });
  expect(paste.when!(file, context), 'a copy, and the adapter cannot copy').toBe(false);
});
