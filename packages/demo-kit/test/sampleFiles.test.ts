import { expect, test } from 'vitest';
import { sampleFiles } from '../src';

test('two calls produce deeply equal trees, binary files included', () => {
  expect(sampleFiles()).toEqual(sampleFiles());
});

test('the tree has one file of every kind the demos show', () => {
  const paths = Object.keys(sampleFiles());
  for (const extension of ['md', 'ts', 'json', 'csv', 'xlsx', 'pdf', 'svg', 'png']) {
    expect(
      paths.some((path) => path.endsWith(`.${extension}`)),
      extension,
    ).toBe(true);
  }
});

test.each([
  ['data/sales.xlsx', [0x50, 0x4b, 0x03, 0x04]],
  ['docs/welcome.pdf', [0x25, 0x50, 0x44, 0x46]],
  ['assets/gradient.png', [0x89, 0x50, 0x4e, 0x47]],
])('%s starts with its format signature', (path, signature) => {
  const bytes = sampleFiles()[path] as Uint8Array;
  expect([...bytes.subarray(0, 4)]).toEqual(signature);
});
