import { lightRenderers, resolveRenderer, type Renderer } from '@scope/react';
import { expect, test, vi } from 'vitest';
import { markdownRenderer } from '../src';
import { allowedLinkUrl } from '../src/links';
import { escapeBlockStart } from '../src/transformers/paragraph';

vi.stubGlobal('location', new URL('https://app.example/files/'));

const markdown = markdownRenderer();
const renderers: Renderer[] = [markdown, ...lightRenderers];
const file = (name: string, size?: number) => ({ path: name, name, kind: 'file' as const, size });

test('an editable text renderer with rendered and source modes', () => {
  expect(markdown).toMatchObject({ id: 'markdown', input: 'text', editable: true });
  expect(markdown.modes).toEqual([
    { value: 'rendered', label: 'Rendered' },
    { value: 'source', label: 'Source' },
  ]);
});

test.each(['README.md', 'notes.markdown', 'a.mkd', 'b.MDOWN'])(
  '%s opens in the Markdown renderer',
  (name) => {
    expect(resolveRenderer(file(name, 100), renderers)?.id).toBe('markdown');
  },
);

test.each(['a.mdx', 'a.txt', 'Makefile'])('%s is not Markdown', (name) => {
  expect(resolveRenderer(file(name, 100), renderers)?.id).not.toBe('markdown');
});

test('match returns false above 500,000 characters, so the code (or text) renderer takes the file', () => {
  expect(markdown.match({ ...file('big.md', 500_000), extension: 'md', basename: 'big.md' })).not.toBe(false);
  expect(markdown.match({ ...file('big.md', 500_001), extension: 'md', basename: 'big.md' })).toBe(false);
  expect(resolveRenderer(file('big.md', 600_000), renderers)?.id).toBe('text');
});

test.each([
  ['https://example.com/a', 'https://example.com/a'],
  ['mailto:a@example.com', 'mailto:a@example.com'],
  ['javascript:alert(1)', null],
  ['data:text/html,<b>x</b>', null],
  ['blob:https://example.com/id', null],
  ['/relative/path', null],
  ['  HTTPS://EXAMPLE.COM  ', 'https://example.com/'],
  ['https://user:secret@example.com/', null],
  ['https://user@example.com/', null],
  ['https://:secret@example.com/', null],
])('allowedLinkUrl(%j) is %j', (url, allowed) => {
  expect(allowedLinkUrl(url)).toBe(allowed);
});

test.each([
  ['1. not a list', '1\\. not a list'],
  ['# not a heading', '\\# not a heading'],
  ['> not a quote', '\\> not a quote'],
  ['- not a bullet', '\\- not a bullet'],
  ['+ not a bullet', '\\+ not a bullet'],
  ['---', '\\---'],
  ['#hashtag', '#hashtag'],
  ['2024 was a year', '2024 was a year'],
  ['a - b', 'a - b'],
])('escapeBlockStart(%j) is %j', (line, escaped) => {
  expect(escapeBlockStart(line)).toBe(escaped);
});
