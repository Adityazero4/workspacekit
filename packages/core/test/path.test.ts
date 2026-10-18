import { expect, test } from 'vitest';
import { FsError } from '../src/errors';
import {
  basename,
  depthOf,
  extname,
  isSameOrDescendant,
  joinPath,
  normalizePath,
  parentPath,
  remapPrefix,
  resolveUnder,
} from '../src/path';

test('normalizePath', () => {
  expect(normalizePath('/a//b/./c/')).toBe('a/b/c');
  expect(normalizePath('')).toBe('');
  expect(() => normalizePath('a/../../x')).toThrow(FsError);
  expect(normalizePath('a/b/../c')).toBe('a/c');
  expect(() => normalizePath('a\0b')).toThrow(FsError);
});

test('normalizePath error kinds', () => {
  expect(() => normalizePath('a/../../x')).toThrow(expect.objectContaining({ kind: 'forbidden' }));
  expect(() => normalizePath('a\0b')).toThrow(expect.objectContaining({ kind: 'invalid' }));
});

test('normalizePath rejects lone UTF-16 surrogates but keeps valid pairs', () => {
  for (const bad of ['a\uD800b', '\uDC00', 'x/\uD83D', 'a\uDE00\uD83Db']) {
    expect(() => normalizePath(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ kind: 'invalid' }));
  }
  expect(normalizePath('a/\u{1F600}/b')).toBe('a/\u{1F600}/b');
});

test('normalizePath normalizes to NFC', () => {
  expect(normalizePath('é')).toBe('é');
  expect(normalizePath('é')).toBe('é');
});

test('joinPath / depthOf', () => {
  expect(joinPath('a', 'b/c', '../d')).toBe('a/b/d');
  expect(joinPath('', 'a')).toBe('a');
  expect(joinPath()).toBe('');
  expect(depthOf('')).toBe(0);
  expect(depthOf('a')).toBe(1);
  expect(depthOf('a/b')).toBe(2);
});

test('extname/basename', () => {
  expect(extname('dir/Report.MD')).toBe('md');
  expect(extname('.env')).toBe('');
  expect(extname('Makefile')).toBe('');
  expect(basename('a/b/c.txt')).toBe('c.txt');
  expect(basename('')).toBe('');
  expect(parentPath('a')).toBe('');
  expect(parentPath('a/b')).toBe('a');
  expect(parentPath('')).toBe('');
});

test('isSameOrDescendant is segment safe', () => {
  expect(isSameOrDescendant('a/bc', 'a/b')).toBe(false);
  expect(isSameOrDescendant('a/b/c', 'a/b')).toBe(true);
  expect(isSameOrDescendant('a/b', 'a/b')).toBe(true);
  expect(isSameOrDescendant('x', '')).toBe(true);
});

test('remapPrefix', () => {
  expect(remapPrefix('a/b/c', 'a/b', 'z')).toBe('z/c');
  expect(remapPrefix('a/bc', 'a/b', 'z')).toBe('a/bc');
  expect(remapPrefix('a/b', 'a/b', 'z')).toBe('z');
  expect(remapPrefix('a/b', 'a/b', '')).toBe('');
  expect(remapPrefix('a/b/c', 'a/b', '')).toBe('c');
});

test('normalizePath rejects backslashes', () => {
  expect(() => normalizePath('a\\..\\..\\x')).toThrow(expect.objectContaining({ kind: 'invalid' }));
});

test('normalizePath rejects dot/space-only segments other than "." and ".."', () => {
  for (const p of ['a/.. /b', 'a/. /b', 'a/.../b', 'a/ /b'])
    expect(() => normalizePath(p)).toThrow(expect.objectContaining({ kind: 'invalid' }));
  expect(normalizePath('a/./b')).toBe('a/b');
});

test('resolveUnder keeps results inside base', () => {
  expect(resolveUnder('up', 'proj/src/a.ts')).toBe('up/proj/src/a.ts');
  expect(() => resolveUnder('up', '../other/x')).toThrow(expect.objectContaining({ kind: 'forbidden' }));
  expect(() => resolveUnder('up', 'a/../../x')).toThrow(FsError);
  expect(resolveUnder('', 'a/b')).toBe('a/b');
});
