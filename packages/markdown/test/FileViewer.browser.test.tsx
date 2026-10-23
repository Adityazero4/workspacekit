import { statusOf } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import {
  FileSystemProvider,
  FileViewer,
  lightRenderers,
  useFileSystem,
  type FileSystemContext,
} from '@scope/react';
import '@scope/react/styles.css';
import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { shown } from './shown';
import { markdownRenderer } from '../src';

const AFTER_AN_AUTOSAVE = { timeout: 4000 };
const renderers = [markdownRenderer({ classNames: { 'md-editor': 'my-editor' } }), ...lightRenderers];

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

async function mountViewer(
  files: Record<string, string>,
  path: string,
): Promise<{ memory: MemoryAdapter; unmount: () => Promise<void> }> {
  const memory = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  const screen = await render(
    <FileSystemProvider adapter={memory}>
      <div style={{ height: 420, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path={path} renderers={renderers} />
      </div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  return { memory, unmount: () => screen.unmount() };
}

const editable = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=md-editor] > [contenteditable]');
const shownText = (): string | undefined => editable()?.textContent ?? undefined;
const saveBanner = (): Element | null => document.querySelector('[data-fs-part=save-banner]');

async function typeAtEndOf(text: string, typed: string): Promise<void> {
  const block = [...editable()!.querySelectorAll('p, h1, h2, li')].find(
    (element) => element.textContent === text,
  )!;
  await userEvent.click(block);
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await userEvent.keyboard(typed);
}

const README = '---\r\ntitle: Readme\r\n---\r\n\r\n# Readme\r\n\r\n* one\r\n* two\r\n\r\nText.\r\n';

test('opening and closing a file without editing writes nothing', async () => {
  const { memory, unmount } = await mountViewer({ 'README.md': README }, 'README.md');
  const write = vi.spyOn(memory, 'write');
  await expect.poll(shownText).toContain('Text.');
  expect(editable()!.getAttribute('aria-label')).toBe('Contents of README.md');
  expect(document.querySelector('[data-fs-part=md-editor]')!.classList.contains('my-editor')).toBe(true);
  await userEvent.click(editable()!);
  await unmount();
  expect(write).not.toHaveBeenCalled();
  expect(await memory.read('README.md', 'text')).toBe(README);
});

test('an edit autosaves with frontmatter and CRLF kept; an agent write then updates in place', async () => {
  const { memory } = await mountViewer({ 'README.md': README }, 'README.md');
  await expect.poll(shownText).toContain('Text.');
  const shown = editable();
  await typeAtEndOf('Text.', ' Mine.');
  await expect
    .poll(() => memory.read('README.md', 'text'), AFTER_AN_AUTOSAVE)
    .toBe(README.replace('Text.', 'Text. Mine.'));
  await memory.write!('README.md', README.replace('Text.', 'Text. Mine. Theirs.'));
  await expect.poll(shownText).toContain('Theirs.');
  expect(editable(), 'the same editor').toBe(shown);
  expect(saveBanner()).toBeNull();
});

test('an agent write over edits not yet saved raises the conflict and leaves the editor alone', async () => {
  const { memory } = await mountViewer({ 'a.md': 'Start.\n' }, 'a.md');
  await expect.poll(shownText).toContain('Start.');
  await typeAtEndOf('Start.', ' Mine');
  await memory.write!('a.md', 'Theirs.\n');
  await expect.poll(saveBanner, AFTER_AN_AUTOSAVE).not.toBeNull();
  expect(shownText()).toContain('Start. Mine');
});

test('Take theirs shows their text in a fresh editor', async () => {
  const { memory } = await mountViewer({ 'a.md': 'Start.\n' }, 'a.md');
  await expect.poll(shownText).toContain('Start.');
  const before = editable();
  await typeAtEndOf('Start.', ' Mine');
  await memory.write!('a.md', 'Theirs.\n');
  await expect.poll(saveBanner, AFTER_AN_AUTOSAVE).not.toBeNull();
  const takeTheirs = [...saveBanner()!.querySelectorAll('button')].find(
    (button) => button.textContent === 'Take theirs',
  )!;
  await userEvent.click(takeTheirs);
  await expect.poll(shownText).toBe('Theirs.');
  expect(editable()).not.toBe(before);
  expect(await memory.read('a.md', 'text')).toBe('Theirs.\n');
});

test('source mode shows the exact text in the source renderer, and edits there save', async () => {
  const { memory } = await mountViewer({ 'a.md': '_exact_  text\n' }, 'a.md');
  await expect.poll(shownText).toContain('exact');
  const source = [...document.querySelectorAll('[data-fs-part=viewer-modes] button')].find(
    (button) => button.textContent === 'Source',
  )!;
  await userEvent.click(source);
  const textarea = await shown<HTMLTextAreaElement>('textarea');
  expect(textarea.value).toBe('_exact_  text\n');
  expect(editable()).toBeNull();
  await userEvent.click(textarea);
  await userEvent.keyboard('{Control>}{End}{/Control}!');
  await expect.poll(() => memory.read('a.md', 'text'), AFTER_AN_AUTOSAVE).toBe('_exact_  text\n!');
});
