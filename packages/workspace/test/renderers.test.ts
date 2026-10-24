import type { Entry } from '@workspacekit/core';
import { resolveRenderer } from '@workspacekit/react';
import { expect, test } from 'vitest';
import { allRenderers } from '../src';

const fileNamed = (name: string): Entry => ({ path: name, name, kind: 'file', size: 100 });
const folder: Entry = { path: 'src', name: 'src', kind: 'directory' };

test.each([
  ['report.pdf', 'pdf'],
  ['letter.docx', 'docx'],
  ['deck.pptx', 'pptx'],
  ['budget.xlsx', 'spreadsheet'],
  ['data.csv', 'spreadsheet'],
  ['notes.md', 'markdown'],
  ['main.ts', 'code'],
  ['.gitignore', 'code'],
  ['photo.png', 'image'],
  ['notes.txt', 'text'],
  ['mystery.bin', 'unsupported'],
])('%s opens with the %s renderer', (name, id) => {
  expect(resolveRenderer(fileNamed(name), allRenderers())?.id).toBe(id);
});

test('a folder opens with the directory renderer', () => {
  expect(resolveRenderer(folder, allRenderers())?.id).toBe('directory');
});

test('a Markdown file too large for the rendered view falls to the code renderer', () => {
  const huge: Entry = { ...fileNamed('huge.md'), size: 600_000 };
  expect(resolveRenderer(huge, allRenderers())?.id).toBe('code');
});
