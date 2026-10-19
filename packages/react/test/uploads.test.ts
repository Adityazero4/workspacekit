import { captureDataTransfer, createTreeStore, type DropEntry, type FsError } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import { describe, expect, test } from 'vitest';
import type { Notice } from '../src/provider/hooks';
import { createRowLayout } from '../src/tree/rowLayout';
import { createConflictQueue } from '../src/dialogs/conflicts';
import { createUploads } from '../src/uploads/uploads';

const fileEntry = (fullPath: string): DropEntry => ({
  isFile: true,
  isDirectory: false,
  name: fullPath.split('/').at(-1)!,
  fullPath,
  file: (ok) => ok(new File([fullPath], fullPath.split('/').at(-1)!)),
});
const folderEntry = (fullPath: string, children: DropEntry[]): DropEntry => {
  let read = false;
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.split('/').at(-1)!,
    fullPath,
    createReader: () => ({
      readEntries: (ok) => {
        ok(read ? [] : children);
        read = true;
      },
    }),
  };
};
const stubDataTransfer = (entries: DropEntry[]): DataTransfer =>
  ({
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
    files: [],
  }) as unknown as DataTransfer;

const setUp = (files: Record<string, string> = {}, latencyMs = 0) => {
  const adapter = createMemoryAdapter({ files, latencyMs });
  const store = createTreeStore(adapter);
  const notices: Notice[] = [];
  const reported: FsError[] = [];
  const uploads = createUploads({
    adapter,
    store,
    notify: (notice) => notices.push(notice),
    report: (error) => reported.push(error),
    conflictPolicy: () => undefined,
    conflicts: createConflictQueue(),
  });
  const exists = async (path: string): Promise<boolean> => (await adapter.stat!(path)) !== null;
  return { adapter, uploads, notices, reported, exists };
};

describe('createUploads', () => {
  test('a folder captured from a drop lands under the target folder, without node_modules', async () => {
    const { uploads, exists } = setUp({ 'target/keep.txt': '' });
    const dropped = captureDataTransfer(
      stubDataTransfer([
        folderEntry('/photos', [
          fileEntry('/photos/cat.png'),
          folderEntry('/photos/nested', [fileEntry('/photos/nested/dog.png')]),
          folderEntry('/photos/node_modules', [fileEntry('/photos/node_modules/x.js')]),
        ]),
      ]),
    );
    const result = await uploads.upload(dropped, 'target');
    expect(result.uploaded.map((entry) => entry.path).sort()).toEqual([
      'target/photos/cat.png',
      'target/photos/nested/dog.png',
    ]);
    expect(await exists('target/photos/node_modules')).toBe(false);
    expect(uploads.runs.get()).toMatchObject([
      { targetDir: 'target', status: 'done', topLevelNames: ['photos'], progress: { done: 2, total: 2 } },
    ]);
    expect(uploads.announcement.get()).toBe('Uploaded 2 files to "target".');
  });

  test('over the file limit, nothing is uploaded and a notice says why', async () => {
    const { uploads, notices, exists } = setUp();
    const files = Array.from({ length: 501 }, (_, at) => ({
      file: new File(['x'], `f${at}.txt`),
      relativePath: `f${at}.txt`,
    }));
    const result = await uploads.upload(files, '');
    expect(result.uploaded).toEqual([]);
    expect(await exists('f0.txt')).toBe(false);
    expect(uploads.runs.get()).toEqual([]);
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringMatching(/500/) }),
    ]);
    expect(uploads.announcement.get(), 'the live region says it too').toBe(notices[0]!.message);
  });

  test('a drop whose every file is skipped uploads nothing and names what was skipped', async () => {
    const { uploads, notices } = setUp();
    const dropped = captureDataTransfer(
      stubDataTransfer([
        folderEntry('/node_modules', [fileEntry('/node_modules/x.js')]),
        fileEntry('/.DS_Store'),
      ]),
    );
    const result = await uploads.upload(dropped, '');
    expect(result.skipped).toEqual(['node_modules', '.DS_Store']);
    expect(uploads.runs.get()).toEqual([]);
    expect(notices).toEqual([
      {
        kind: 'info',
        message: 'Nothing was uploaded: node_modules, .DS_Store skipped as system or tooling files.',
      },
    ]);
    expect(uploads.announcement.get()).toBe(notices[0]!.message);
  });

  test('failed files mark the run failed, announce it once and report every error', async () => {
    const { uploads, notices, reported } = setUp({ notes: '' });
    const files = ['b.txt', 'c.txt'].map((name) => ({ file: new File(['x'], name), relativePath: name }));
    const result = await uploads.upload(files, 'notes');
    expect(result.failed).toHaveLength(2);
    expect(uploads.runs.get()[0]?.status).toBe('failed');
    expect(uploads.announcement.get()).toBe('2 of 2 files failed to upload to "notes".');
    expect(notices).toEqual([{ kind: 'error', message: '2 of 2 files failed to upload to "notes".' }]);
    expect(reported).toEqual(result.failed.map((failure) => failure.error));
  });

  test('dismiss removes a finished run; cancelAll aborts running ones', async () => {
    const { uploads } = setUp({}, 50);
    await uploads.upload([{ file: new File(['x'], 'a.txt'), relativePath: 'a.txt' }], '');
    const [finished] = uploads.runs.get();
    uploads.dismiss(finished!.id);
    expect(uploads.runs.get()).toEqual([]);
    const running = uploads.upload([{ file: new File(['x'], 'b.txt'), relativePath: 'b.txt' }], '');
    await expect.poll(() => uploads.runs.get().length).toBe(1);
    uploads.cancelAll();
    expect((await running).cancelled).toBe(true);
  });

  test('an adapter without upload rejects with what to do', async () => {
    const withoutUpload = { ...setUp().adapter, upload: undefined };
    const uploads = createUploads({
      adapter: withoutUpload,
      store: createTreeStore(withoutUpload),
      notify: () => undefined,
      report: () => undefined,
      conflictPolicy: () => undefined,
      conflicts: createConflictQueue(),
    });
    await expect(uploads.upload([], '')).rejects.toThrow(/adapter.*upload/);
  });
});

describe('createRowLayout', () => {
  const placeholder = (name: string) => ({ key: name, name, depth: 1, percent: 0, target: null });
  const layout = createRowLayout(5, [
    { afterRowIndex: -1, rows: [placeholder('top')] },
    { afterRowIndex: 2, rows: [placeholder('p1'), placeholder('p2')] },
  ]);

  test('places placeholders after their row and keeps every row reachable', () => {
    expect(layout.count).toBe(8);
    expect(Array.from({ length: 8 }, (_, at) => layout.slotAt(at))).toEqual([
      { kind: 'placeholder', placeholder: placeholder('top') },
      { kind: 'row', rowIndex: 0 },
      { kind: 'row', rowIndex: 1 },
      { kind: 'row', rowIndex: 2 },
      { kind: 'placeholder', placeholder: placeholder('p1') },
      { kind: 'placeholder', placeholder: placeholder('p2') },
      { kind: 'row', rowIndex: 3 },
      { kind: 'row', rowIndex: 4 },
    ]);
    expect([0, 1, 2, 3, 4].map(layout.positionOf)).toEqual([1, 2, 3, 6, 7]);
  });

  test('maps a placeholder to the row after it, for sticky headers', () => {
    expect(layout.rowIndexAtOrAfter(0)).toBe(0);
    expect(layout.rowIndexAtOrAfter(4)).toBe(3);
    expect(layout.rowIndexAtOrAfter(6)).toBe(3);
  });

  test('without placeholders it is the identity', () => {
    const identity = createRowLayout(3, []);
    expect(identity.count).toBe(3);
    expect(identity.slotAt(2)).toEqual({ kind: 'row', rowIndex: 2 });
    expect(identity.positionOf(2)).toBe(2);
  });
});
