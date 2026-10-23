import { expect, test } from 'vitest';
import { joinDocument, splitDocument } from '../src/frontmatter';

test('YAML frontmatter and the blank lines after it are kept apart from the body', () => {
  const text = '---\ntitle: A | B\ntags: [a]\n---\n\n# Title\n\nBody\n';
  expect(splitDocument(text)).toEqual({
    before: '---\ntitle: A | B\ntags: [a]\n---\n\n',
    body: '# Title\n\nBody',
    after: '\n',
  });
});

test('frontmatter may close with ...', () => {
  expect(splitDocument('---\na: 1\n...\ntext').before).toBe('---\na: 1\n...\n');
});

test('a document without frontmatter keeps its leading and trailing blank lines', () => {
  expect(splitDocument('\n\nHello\n\n\n')).toEqual({ before: '\n\n', body: 'Hello', after: '\n\n\n' });
});

test('an unclosed --- block is body, not frontmatter', () => {
  expect(splitDocument('---\nnot closed\n').before).toBe('');
  expect(splitDocument('--- \na\n---\n').before).toBe('');
});

test('a thematic break at the very start is not frontmatter unless it is closed', () => {
  expect(splitDocument('---\n\nText').before).toBe('');
});

test('joining the parts gives the text back', () => {
  for (const text of ['', '\n', '---\na: 1\n---\nx', '\n\nA\n\nB\n\n', 'x']) {
    expect(joinDocument(splitDocument(text))).toBe(text);
  }
});

test('the split is a linear scan on a document of a million blank lines', () => {
  const text = '\n'.repeat(1_000_000);
  expect(joinDocument(splitDocument(text))).toBe(text);
});
