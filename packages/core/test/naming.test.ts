import { expect, test } from 'vitest';
import { splitName, uniqueName, validateName, validateTransfer } from '../src/naming';

test('splitName', () => {
  expect(splitName('report.md')).toEqual({ stem: 'report', ext: '.md' });
  expect(splitName('.env')).toEqual({ stem: '.env', ext: '' });
  expect(splitName('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
  expect(splitName('a.tar.gz')).toEqual({ stem: 'a.tar', ext: '.gz' });
});

test('uniqueName', () => {
  expect(uniqueName('report.md', new Set(['report.md']))).toBe('report copy.md');
  expect(uniqueName('report.md', new Set(['report.md', 'report copy.md']))).toBe('report copy 2.md');
  expect(uniqueName('.env', new Set(['.env']))).toBe('.env copy');
  expect(uniqueName('Makefile', new Set(['Makefile']))).toBe('Makefile copy');
  expect(uniqueName('a.tar.gz', new Set(['a.tar.gz']))).toBe('a.tar copy.gz');
  expect(uniqueName('free.txt', new Set())).toBe('free.txt');
});

test('validateName', () => {
  const sib = new Set(['a.txt']);
  expect(validateName('  ', sib)).toBe('empty');
  expect(validateName('a/b', sib)).toBe('invalid_chars');
  expect(validateName('a\\b', sib)).toBe('invalid_chars');
  expect(validateName('a\0b', sib)).toBe('invalid_chars');
  expect(validateName('a\nb', sib)).toBe('invalid_chars');
  expect(validateName('..', sib)).toBe('reserved');
  expect(validateName('.', sib)).toBe('reserved');
  expect(validateName('x'.repeat(256), sib)).toBe('too_long');
  expect(validateName('x'.repeat(255), sib)).toBeNull();
  expect(validateName('é'.repeat(128), sib)).toBe('too_long'); // 256 UTF-8 bytes
  expect(validateName('A.TXT', sib)).toBe('duplicate');
  expect(validateName('b.txt', sib)).toBeNull();
  // NFC-insensitive duplicate
  expect(validateName('é.txt', new Set(['é.txt']))).toBe('duplicate');
});

test('validateTransfer', () => {
  expect(validateTransfer('move', 'a/b', 'a/b/c')).toBe('into_self');
  expect(validateTransfer('copy', 'a/b', 'a/b')).toBe('into_self');
  expect(validateTransfer('move', 'a/b', 'a')).toBe('noop');
  expect(validateTransfer('copy', 'a/b', 'a')).toBeNull();
  expect(validateTransfer('move', 'a/b', 'a/bc')).toBeNull();
  expect(validateTransfer('move', 'a', '')).toBe('noop');
  expect(validateTransfer('move', 'a', 'b')).toBeNull();
});

test('validateName rejects bidi, zero-width and other invisible format characters', () => {
  for (const ch of ['\u202E', '\u202A', '\u2066', '\u200B', '\u200E', '\u200F', '\u2060', '\uFEFF', '\u007F', '\u0085'])
    expect(validateName(`a${ch}b.txt`, new Set())).toBe('invalid_chars');
  expect(validateName('family \u{1F468}\u200D\u{1F469}.txt', new Set())).toBeNull(); // ZWJ emoji allowed
});

test('validateName rejects all format/invisible characters except scoped joiners', () => {
  for (const ch of ['\u00AD', '\u061C', '\u180E', '\u2028', '\u2029', '\u206F', '\u115F', '\u1160', '\u3164', '\uFFA0', '\u2800', '\u034F', '\u{E0001}'])
    expect(validateName(`a${ch}b.txt`, new Set())).toBe('invalid_chars');
  expect(validateName('family \u{1F468}\u200D\u{1F469}.txt', new Set())).toBeNull();
});

test('validateName allows ZWNJ inside names and treats joiner-only names as empty', () => {
  expect(validateName('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt', new Set())).toBeNull(); // Persian "mi-khaham"
  expect(validateName('\u200D', new Set())).toBe('empty');
  expect(validateName(' \u200C ', new Set())).toBe('empty');
  expect(validateName('a\u{E0067}b.txt', new Set())).toBe('invalid_chars');
});

test('validateName rejects trailing dot/space and Windows reserved device names', () => {
  for (const n of ['name.', 'name ', 'CON', 'con.txt', 'NUL', 'com1.log', 'LPT9', 'aux.md'])
    expect(validateName(n, new Set())).toBe('reserved');
  expect(validateName('console.txt', new Set())).toBeNull();
});

test('joiners are only allowed between two non-ASCII characters', () => {
  expect(validateName('rep\u200Cort.md', new Set())).toBe('invalid_chars');
  expect(validateName('\u200Dreport.md', new Set())).toBe('invalid_chars');
  expect(validateName('report.md\u200D', new Set())).toBe('invalid_chars');
  expect(validateName('family \u{1F468}\u200D\u{1F469}.txt', new Set())).toBeNull();
  expect(validateName('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt', new Set())).toBeNull(); // Persian
});

test('names differing only by joiners are duplicates', () => {
  expect(validateName('\u0645\u06CC\u062E.txt', new Set(['\u0645\u06CC\u200C\u062E.txt']))).toBe('duplicate');
  expect(uniqueName('\u0645\u06CC\u200C\u062E.txt', new Set(['\u0645\u06CC\u062E.txt']))).toBe('\u0645\u06CC\u200C\u062E copy.txt');
});
