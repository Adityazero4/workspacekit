import { expect, test } from 'vitest';
import { highlightRanges } from '../src/search/highlight';

test('matches ignore case and return every occurrence', () => {
  expect(highlightRanges('ReadMe.md', 'readme')).toEqual([[0, 6]]);
  expect(highlightRanges('a-A-a', 'a')).toEqual([
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
});

test('an empty query or no match gives no ranges', () => {
  expect(highlightRanges('index.ts', '')).toEqual([]);
  expect(highlightRanges('index.ts', 'zzz')).toEqual([]);
});

test('a decomposed name matches a composed query, with ranges in the original name', () => {
  const decomposed = 'café.txt';
  expect(highlightRanges(decomposed, 'café')).toEqual([[0, 5]]);
  expect(highlightRanges(decomposed, 'é')).toEqual([[3, 5]]);
});

test('a composed name matches a decomposed query', () => {
  expect(highlightRanges('café.txt', 'CAFÉ')).toEqual([[0, 4]]);
});

test('ß and ss match each other, and a partial match covers the whole ß', () => {
  expect(highlightRanges('Straße', 'SS')).toEqual([[4, 5]]);
  expect(highlightRanges('Strasse', 'ß')).toEqual([[4, 6]]);
  expect(highlightRanges('Straße', 's')).toEqual([
    [0, 1],
    [4, 5],
  ]);
});

test('ranges after an astral character index UTF-16 code units', () => {
  expect(highlightRanges('\u{1F600}a.txt', 'a')).toEqual([[2, 3]]);
});
