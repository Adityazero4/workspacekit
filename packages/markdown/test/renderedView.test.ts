import { expect, test } from 'vitest';
import { estimatedImportWork, fitsTheRenderedView, RENDERED_VIEW_MAX_CHARACTERS } from '../src/renderedView';

test('ordinary documents fit the rendered view', () => {
  const readme = '# Title\n\nSome *emphasis* and a [link](https://example.com).\n\n- one\n- two\n'.repeat(
    2000,
  );
  expect(fitsTheRenderedView(readme)).toBe(true);
});

test('documents over 500,000 characters do not fit, whatever they hold', () => {
  expect(RENDERED_VIEW_MAX_CHARACTERS).toBe(500_000);
  expect(fitsTheRenderedView('a'.repeat(500_000))).toBe(true);
  expect(fitsTheRenderedView('a'.repeat(500_001))).toBe(false);
});

test.each([
  ['a long line of emphasis', '*a* '.repeat(50_000)],
  ['a long line of brackets', '['.repeat(400_000)],
  ['a paragraph of many short lines', 'a\n'.repeat(100_000)],
  ['a long quote', '> a\n'.repeat(100_000)],
])('%s is too much work for the rendered view', (_, markdown) => {
  expect(fitsTheRenderedView(markdown)).toBe(false);
});

test('fenced code, list items and table rows are not counted as merged paragraph lines', () => {
  const code = '```ts\n' + 'const a = [1, 2]; // *x*\n'.repeat(10_000) + '```\n';
  const list = '- item with *emphasis*\n'.repeat(10_000);
  const table = '| a | b |\n| - | - |\n' + '| *1* | 2 |\n'.repeat(10_000);
  for (const markdown of [code, list, table]) expect(fitsTheRenderedView(markdown)).toBe(true);
});

test('the estimate grows linearly with plain text', () => {
  expect(estimatedImportWork('word '.repeat(1000))).toBeLessThan(10_000);
});
