import { afterEach, beforeEach, expect, test } from 'vitest';
import { fileSystemAccessAdapter } from '../src/fileSystemAccessAdapter';
import { faulty, type Faults } from './faultyHandles';

let originPrivateRoot: FileSystemDirectoryHandle;
let scratchName: string;
let scratch: FileSystemDirectoryHandle;
let adapter: ReturnType<typeof fileSystemAccessAdapter>;

beforeEach(async () => {
  originPrivateRoot = await navigator.storage.getDirectory();
  scratchName = `adapter-test-${crypto.randomUUID()}`;
  scratch = await originPrivateRoot.getDirectoryHandle(scratchName, { create: true });
  adapter = fileSystemAccessAdapter(scratch);
});

afterEach(async () => {
  await originPrivateRoot.removeEntry(scratchName, { recursive: true });
});

test('a written file reads back with the same bytes', async () => {
  await adapter.write!('docs/notes.txt', 'héllo, wörld');
  const bytes = new Uint8Array(await adapter.read('docs/notes.txt', 'arrayBuffer'));
  expect([...bytes]).toEqual([...new TextEncoder().encode('héllo, wörld')]);
  expect(await adapter.read('docs/notes.txt', 'text')).toBe('héllo, wörld');
});

test('a moved file keeps its content and leaves nothing behind', async () => {
  await adapter.write!('a.txt', 'kept');
  const entry = await adapter.move!('a.txt', 'folder/b.txt');
  expect(entry.path).toBe('folder/b.txt');
  expect(await adapter.read('folder/b.txt', 'text')).toBe('kept');
  expect(await adapter.stat!('a.txt')).toBeNull();
});

test('a moved folder takes its files along', async () => {
  await adapter.write!('src/deep/file.txt', 'inside');
  await adapter.move!('src', 'lib');
  expect(await adapter.read('lib/deep/file.txt', 'text')).toBe('inside');
  expect(await adapter.stat!('src')).toBeNull();
});

test('a move onto an existing file conflicts unless it overwrites', async () => {
  await adapter.write!('one.txt', '1');
  await adapter.write!('two.txt', '2');
  await expect(adapter.move!('one.txt', 'two.txt')).rejects.toMatchObject({ kind: 'conflict' });
  await adapter.move!('one.txt', 'two.txt', { overwrite: true });
  expect(await adapter.read('two.txt', 'text')).toBe('1');
});

test('a deleted entry is gone and deleting it again is not_found', async () => {
  await adapter.write!('gone/file.txt', 'x');
  await adapter.delete!('gone');
  expect(await adapter.stat!('gone')).toBeNull();
  await expect(adapter.delete!('gone')).rejects.toMatchObject({ kind: 'not_found' });
});

test('a listing reports kinds and sizes', async () => {
  await adapter.write!('top.txt', 'four');
  await adapter.create!('empty', 'directory');
  await adapter.write!('empty/inner.txt', 'ab');
  const shallow = await adapter.list('', { depth: 1 });
  expect(shallow.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
    { path: 'empty', kind: 'directory', size: undefined },
    { path: 'top.txt', kind: 'file', size: 4 },
  ]);
  const deep = await adapter.list('', { depth: 2 });
  expect(deep.find((entry) => entry.path === 'empty/inner.txt')).toMatchObject({ kind: 'file', size: 2 });
});

test('a write that expects an older mtime conflicts', async () => {
  const first = await adapter.write!('guarded.txt', 'v1');
  await expect(
    adapter.write!('guarded.txt', 'v2', { expectedMtimeMs: first.mtimeMs! - 1 }),
  ).rejects.toMatchObject({
    kind: 'conflict',
  });
  expect(await adapter.read('guarded.txt', 'text')).toBe('v1');
});

test.each([
  ['read', () => adapter.read('../escape.txt', 'text')],
  ['write', () => adapter.write!('../escape.txt', 'x')],
  ['list', () => adapter.list('a/../..', { depth: 1 })],
  ['move', () => adapter.move!('a.txt', '../escape.txt')],
])('%s refuses a path that leaves the folder', async (_name, attempt) => {
  await expect(attempt()).rejects.toMatchObject({ kind: 'forbidden' });
});

test.each([
  ['read', () => adapter.read('missing.txt', 'text')],
  ['list', () => adapter.list('missing', { depth: 1 })],
  ['move', () => adapter.move!('missing.txt', 'elsewhere.txt')],
])('%s of a missing path is not_found', async (_name, attempt) => {
  await expect(attempt()).rejects.toMatchObject({ kind: 'not_found' });
});

test.each([
  ['a backslash', () => adapter.write!('a\\b.txt', 'x'), 'invalid'],
  ['a NUL', () => adapter.write!('a\0b.txt', 'x'), 'invalid'],
  ['the root', () => adapter.write!('', 'x'), 'invalid'],
  ['deleting the root', () => adapter.delete!('/'), 'invalid'],
  ['a dots-only segment', () => adapter.write!('a/.../b.txt', 'x'), 'invalid'],
])('%s is refused', async (_name, attempt, kind) => {
  await expect(attempt()).rejects.toMatchObject({ kind });
});

test('leading slashes, empty segments and inner dot-dots normalize to the same file', async () => {
  await adapter.write!('/docs//a/../notes.txt', 'normalized');
  expect(await adapter.read('docs/notes.txt', 'text')).toBe('normalized');
});

test('a move into itself is invalid and changes nothing', async () => {
  await adapter.write!('box/file.txt', 'x');
  await expect(adapter.move!('box', 'box/inner')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(adapter.move!('box/file.txt', 'box')).rejects.toMatchObject({ kind: 'invalid' });
  expect(await adapter.read('box/file.txt', 'text')).toBe('x');
});

test('a rename that only changes the case keeps the data', async () => {
  await adapter.write!('Readme.txt', 'kept');
  await adapter.move!('Readme.txt', 'README.txt');
  expect(await adapter.read('README.txt', 'text')).toBe('kept');
});

test('a name the browser rejects with a TypeError is reported as invalid', async () => {
  const faults: Faults = { writesAllowed: Infinity, rejectNamesWith: '?' };
  const rejecting = fileSystemAccessAdapter(faulty(scratch, faults));
  await expect(rejecting.write!('what?.txt', 'x')).rejects.toMatchObject({ kind: 'invalid' });
});

function copyingAdapter(faults: Faults): ReturnType<typeof fileSystemAccessAdapter> {
  return fileSystemAccessAdapter(faulty(scratch, faults));
}

test('moving by copying works when move() is missing', async () => {
  await adapter.write!('src/a.txt', 'A');
  await copyingAdapter({ writesAllowed: Infinity }).move!('src', 'lib');
  expect(await adapter.read('lib/a.txt', 'text')).toBe('A');
  expect(await adapter.stat!('src')).toBeNull();
});

test('a copy that fails leaves the source intact and no partial destination', async () => {
  await adapter.write!('src/a.txt', 'A');
  await adapter.write!('src/b.txt', 'B');
  const failing = copyingAdapter({ writesAllowed: 1 });
  await expect(failing.move!('src', 'lib')).rejects.toMatchObject({ kind: 'too_large' });
  expect(await adapter.read('src/a.txt', 'text')).toBe('A');
  expect(await adapter.read('src/b.txt', 'text')).toBe('B');
  expect((await adapter.list('', { depth: 3 })).map((entry) => entry.path)).toEqual([
    'src',
    'src/a.txt',
    'src/b.txt',
  ]);
});

test('an overwriting copy that fails leaves both the destination and the source intact', async () => {
  await adapter.write!('new.txt', 'new');
  await adapter.write!('old.txt', 'old');
  const failing = copyingAdapter({ writesAllowed: 0 });
  await expect(failing.move!('new.txt', 'old.txt', { overwrite: true })).rejects.toMatchObject({
    kind: 'too_large',
  });
  expect(await adapter.read('old.txt', 'text')).toBe('old');
  expect(await adapter.read('new.txt', 'text')).toBe('new');
  expect((await adapter.list('', { depth: 1 })).map((entry) => entry.path)).toEqual(['new.txt', 'old.txt']);
});

test('an overwriting copy replaces the destination and leaves no temporary entry', async () => {
  await adapter.write!('new.txt', 'new');
  await adapter.write!('old.txt', 'old');
  await copyingAdapter({ writesAllowed: Infinity }).move!('new.txt', 'old.txt', { overwrite: true });
  expect(await adapter.read('old.txt', 'text')).toBe('new');
  expect((await adapter.list('', { depth: 1 })).map((entry) => entry.path)).toEqual(['old.txt']);
});

test('an overwrite whose placement fails keeps the new content and names where it is', async () => {
  await adapter.write!('new.txt', 'new');
  await adapter.write!('old.txt', 'old');
  const failure = await copyingAdapter({ writesAllowed: 1 }).move!('new.txt', 'old.txt', {
    overwrite: true,
  }).catch((error: Error) => error);
  expect(failure).toMatchObject({ kind: 'too_large' });
  const stagedName = /kept in (\S+)$/.exec((failure as Error).message)?.[1];
  expect(stagedName).toBeDefined();
  expect(await adapter.read('new.txt', 'text')).toBe('new');
  expect(await adapter.read(stagedName!, 'text')).toBe('new');
});

test.each([
  ['with move()', true],
  ['by copying', false],
])('a case-only rename on a case-insensitive disk keeps the data %s', async (_name, keepMove) => {
  await adapter.write!('Readme.txt', 'kept');
  const insensitive = fileSystemAccessAdapter(
    faulty(scratch, { writesAllowed: Infinity, caseInsensitive: true, keepMove }),
  );
  await insensitive.move!('Readme.txt', 'README.txt');
  expect(await insensitive.read('README.txt', 'text')).toBe('kept');
  expect((await adapter.list('', { depth: 1 })).map((entry) => entry.path)).toEqual(['README.txt']);
});
