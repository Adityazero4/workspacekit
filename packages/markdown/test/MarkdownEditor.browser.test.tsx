import axe from 'axe-core';
import { UNDO_COMMAND, type LexicalEditor } from 'lexical';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { shown } from './shown';
import { MarkdownEditor, type MarkdownEditorProps } from '../src';

const AFTER_A_REPORT = { timeout: 3000 };

afterEach(() => cleanup());

function Sized(props: MarkdownEditorProps): React.JSX.Element {
  return (
    <div style={{ height: 420, display: 'flex', flexDirection: 'column' }}>
      <MarkdownEditor {...props} />
    </div>
  );
}

function Controlled(props: { initial: string; onReport: (text: string) => void }): React.JSX.Element {
  const [value, setValue] = useState(props.initial);
  return (
    <Sized
      value={value}
      fileName="notes.md"
      onChange={(text) => {
        props.onReport(text);
        setValue(text);
      }}
    />
  );
}

const editable = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=md-editor] > [contenteditable]');
const lexicalEditor = (): LexicalEditor =>
  (editable() as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
const shownText = (): string | undefined => editable()?.textContent ?? undefined;

async function caretAtEndOf(text: string): Promise<void> {
  const block = [...editable()!.querySelectorAll('p, h1, h2, li, td')].find(
    (element) => element.textContent === text,
  )!;
  await userEvent.click(block);
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function selectWord(word: string): Promise<void> {
  const walker = document.createTreeWalker(editable()!, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent!.indexOf(word);
    if (start === -1) continue;
    await userEvent.click(node.parentElement!);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + word.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return;
  }
  throw new Error(`"${word}" is not shown`);
}

const DOCUMENT = [
  '---',
  'title: Notes',
  '---',
  '',
  '# Notes',
  '',
  'Intro paragraph.',
  '',
  '| Left | Right |',
  '|:-----|------:|',
  '| a \\| b | 2 |',
  '',
  '~~~sh',
  'echo hi',
  '~~~',
  '',
  '***',
  '',
  'Last line.',
  '',
].join('\n');

test('opening and closing without an edit reports nothing', async () => {
  const onChange = vi.fn();
  const screen = await render(<Sized value={DOCUMENT} fileName="notes.md" onChange={onChange} />);
  await expect.poll(shownText).toContain('Last line.');
  await userEvent.click(editable()!);
  await userEvent.keyboard('{ArrowDown}{ArrowUp}');
  await userEvent.click(document.body);
  await screen.unmount();
  expect(onChange).not.toHaveBeenCalled();
});

test('an edit keeps frontmatter, the aligned table with its escaped pipe, the ~~~ fence and ***', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={DOCUMENT} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('Last line.');
  await caretAtEndOf('Last line.');
  await userEvent.keyboard(' Edited');
  await expect
    .poll(() => reports.at(-1), AFTER_A_REPORT)
    .toBe(DOCUMENT.replace('Last line.', 'Last line. Edited'));
});

test('CRLF files are reported with CRLF line breaks', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'# A\r\n\r\nB\r\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('B');
  await caretAtEndOf('B');
  await userEvent.keyboard('C');
  await expect.poll(() => reports.at(-1), AFTER_A_REPORT).toBe('# A\r\n\r\nBC\r\n');
});

test('the may-reformat notice appears once, on the first edit of a file the editor would rewrite', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'_one_\n\n+ two\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('one');
  expect(document.querySelector('[data-fs-part=md-notice]')).toBeNull();
  await caretAtEndOf('one');
  await userEvent.keyboard('!');
  await expect
    .poll(() => document.querySelectorAll('[data-fs-part=md-notice]').length, AFTER_A_REPORT)
    .toBe(1);
  expect(reports.at(-1)).toBe('*one!*\n\n+ two\n');
  await userEvent.click(document.querySelector('[data-fs-part=md-notice] button')!);
  await caretAtEndOf('one!');
  await userEvent.keyboard('!');
  await expect.poll(() => reports.at(-1), AFTER_A_REPORT).toBe('*one!!*\n\n+ two\n');
  expect(document.querySelector('[data-fs-part=md-notice]')).toBeNull();
});

test('no notice for a file the editor writes back exactly', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'# A\n\nB\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('B');
  await caretAtEndOf('B');
  await userEvent.keyboard('C');
  await expect.poll(() => reports.at(-1), AFTER_A_REPORT).toBe('# A\n\nBC\n');
  expect(document.querySelector('[data-fs-part=md-notice]')).toBeNull();
});

test('a remote update while clean replaces the content outside the undo history', async () => {
  const screen = await render(<Sized value={'# One\n\nFirst.\n'} fileName="a.md" onChange={() => {}} />);
  await expect.poll(shownText).toContain('First.');
  await screen.rerender(<Sized value={'# One\n\nSecond.\n'} fileName="a.md" onChange={() => {}} />);
  await expect.poll(shownText).toContain('Second.');
  lexicalEditor().dispatchCommand(UNDO_COMMAND, undefined);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(shownText()).toContain('Second.');
});

test('a remote update never overwrites edits that are not reported yet', async () => {
  const onChange = vi.fn();
  const screen = await render(<Sized value={'Mine.\n'} fileName="a.md" onChange={onChange} />);
  await expect.poll(shownText).toContain('Mine.');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await caretAtEndOf('Mine.');
    await userEvent.keyboard('!');
    await screen.rerender(<Sized value={'Theirs.\n'} fileName="a.md" onChange={onChange} />);
    expect(shownText()).toContain('Mine.!');
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledWith('Mine.!\n');
  } finally {
    vi.useRealTimers();
  }
});

test('the slash menu works from the keyboard', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'Start\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('Start');
  await caretAtEndOf('Start');
  await userEvent.keyboard('{Enter}/head');
  const menu = await shown('[data-fs-part=md-slash-menu]');
  expect(menu.getAttribute('role')).toBe('listbox');
  expect([...menu.querySelectorAll('[role=option]')].map((option) => option.textContent)).toEqual([
    'Heading 1',
    'Heading 2',
    'Heading 3',
  ]);
  await userEvent.keyboard('{ArrowDown}');
  expect(editable()!.getAttribute('aria-activedescendant')).toBe('typeahead-item-1');
  expect(menu.querySelector('[aria-selected=true]')!.textContent).toBe('Heading 2');
  await userEvent.keyboard('{Enter}Title');
  await expect.poll(() => reports.at(-1), AFTER_A_REPORT).toBe('Start\n\n## Title\n');
  expect(document.querySelector('[data-fs-part=md-slash-menu]')).toBeNull();
});

test('Ctrl/Cmd+K edits a link from the keyboard, refusing unsafe URLs', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'Read the docs.\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('docs');
  await selectWord('docs');
  await userEvent.keyboard('{Control>}k{/Control}');
  const dialog = await shown<HTMLElement>('[data-fs-part=md-link-editor]');
  expect(dialog.getAttribute('role')).toBe('dialog');
  expect(document.activeElement).toBe(dialog.querySelector('input'));
  await userEvent.keyboard('javascript:alert(1){Enter}');
  expect(dialog.querySelector('[role=alert]')).not.toBeNull();
  expect(dialog.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
  await userEvent.clear(dialog.querySelector('input')!);
  await userEvent.keyboard('https://example.com/docs{Enter}');
  await expect
    .poll(() => reports.at(-1), AFTER_A_REPORT)
    .toBe('Read the [docs](https://example.com/docs).\n');
  expect(document.querySelector('[data-fs-part=md-link-editor]')).toBeNull();
  expect(editable()!.contains(document.activeElement)).toBe(true);
});

test('Escape closes the link editor and returns focus to the text', async () => {
  await render(<Sized value={'Text\n'} fileName="a.md" onChange={() => {}} />);
  await expect.poll(shownText).toContain('Text');
  await caretAtEndOf('Text');
  await userEvent.keyboard('{Control>}k{/Control}');
  await expect
    .poll(() => document.querySelector('[data-fs-part=md-link-editor] input') === document.activeElement)
    .toBe(true);
  await userEvent.keyboard('{Escape}');
  expect(document.querySelector('[data-fs-part=md-link-editor]')).toBeNull();
  expect(editable()!.contains(document.activeElement)).toBe(true);
});

test('Alt+F10 reaches the floating toolbar; arrows move, Escape returns, Enter formats and returns to the text', async () => {
  const reports: string[] = [];
  await render(<Controlled initial={'Make this bold.\n'} onReport={(text) => reports.push(text)} />);
  await expect.poll(shownText).toContain('bold');
  await selectWord('bold');
  const toolbar = await shown<HTMLElement>('[data-fs-part=md-toolbar]');
  expect(toolbar.getAttribute('role')).toBe('toolbar');
  await userEvent.keyboard('{Alt>}{F10}{/Alt}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Bold');
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Italic');
  const tabStops = (): string[] =>
    [...toolbar.querySelectorAll('button')]
      .filter((button) => button.tabIndex === 0)
      .map((button) => button.textContent!);
  expect(tabStops()).toEqual(['I']);
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => editable()!.contains(document.activeElement)).toBe(true);
  await userEvent.keyboard('{Alt>}{F10}{/Alt}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Italic');
  await userEvent.keyboard('{ArrowLeft}{Enter}');
  await expect.poll(() => reports.at(-1), AFTER_A_REPORT).toBe('Make this **bold**.\n');
  expect(toolbar.querySelector('[aria-label=Bold]')!.getAttribute('aria-pressed')).toBe('true');
  expect(editable()!.contains(document.activeElement)).toBe(true);
});

test('links get an allowed scheme, a new tab and noopener; others are not links; images and HTML are not loaded', async () => {
  const markdown = [
    '[safe](https://example.com) [mail](mailto:a@example.com) [bad](javascript:alert(1)) [data](data:text/html,x)',
    '',
    '![pixel](https://example.invalid/pixel.png)',
    '',
    '<img src="https://example.invalid/x.png" onerror="alert(1)">',
  ].join('\n');
  await render(<Sized value={markdown} fileName="a.md" readOnly />);
  await expect.poll(shownText).toContain('safe');
  const anchors = [...editable()!.querySelectorAll('a')];
  const byText = (text: string): HTMLAnchorElement => anchors.find((anchor) => anchor.textContent === text)!;
  expect(byText('safe').getAttribute('href')).toBe('https://example.com/');
  expect(byText('mail').getAttribute('href')).toBe('mailto:a@example.com');
  expect(byText('bad').hasAttribute('href')).toBe(false);
  expect(byText('data').hasAttribute('href')).toBe(false);
  for (const anchor of anchors) {
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  }
  expect(byText('pixel').getAttribute('href')).toBe('https://example.invalid/pixel.png');
  expect(document.querySelectorAll('img')).toHaveLength(0);
  expect(shownText()).toContain('<img src=');
});

test('source mode uses the source editor, and a value over 500,000 characters is shown as source', async () => {
  const screen = await render(<Sized value={'# Title\n'} fileName="a.md" mode="source" />);
  await expect.poll(() => document.querySelector('textarea')?.value).toBe('# Title\n');
  expect(editable()).toBeNull();
  await screen.rerender(<Sized value={'a'.repeat(500_001)} fileName="a.md" />);
  await expect.poll(() => document.querySelector('textarea, [data-fs-part=text-lines]')).not.toBeNull();
  expect(document.querySelector('[data-fs-part=md-notice]')!.textContent).toContain('shown as source');
  expect(editable()).toBeNull();
});

test('a list nested 8,000 spaces deep opens as source instead of crashing the engine', async () => {
  await render(<Sized value={`${' '.repeat(8_000)}- a\n`} fileName="deep.md" onChange={() => {}} />);
  await expect
    .poll(() => document.querySelector('[data-fs-part=md-notice]')?.textContent)
    .toContain('shown as source');
  expect(editable()).toBeNull();
});

test('typing past the size budget keeps the rendered editor: only text from outside is gated', async () => {
  const reports: string[] = [];
  const atTheLimit = 'a'.repeat(499_999);
  await render(<Controlled initial={`${atTheLimit}\n`} onReport={(text) => reports.push(text)} />);
  await expect.poll(() => shownText()?.length).toBe(499_999);
  const shownEditor = editable();
  await caretAtEndOf(atTheLimit);
  await userEvent.keyboard('bc');
  await expect.poll(() => reports.at(-1)?.length, AFTER_A_REPORT).toBe(500_002);
  expect(editable()).toBe(shownEditor);
  expect(document.querySelector('[data-fs-part=md-notice]')).toBeNull();
});

test('read-only stays focusable and does not edit', async () => {
  const onChange = vi.fn();
  await render(<Sized value={'Fixed.\n'} fileName="a.md" readOnly onChange={onChange} />);
  await expect.poll(shownText).toContain('Fixed.');
  expect(editable()!.getAttribute('contenteditable')).toBe('false');
  expect(editable()!.getAttribute('aria-readonly')).toBe('true');
  expect(editable()!.tabIndex).toBe(0);
  expect(editable()!.getAttribute('aria-label')).toBe('Contents of a.md');
});

test('axe finds nothing in light and dark, with the toolbar and the slash menu open', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const screen = await render(
      <Sized value={DOCUMENT} fileName="notes.md" theme={theme} onChange={() => {}} />,
    );
    await expect.poll(shownText).toContain('Last line.');
    await selectWord('Intro');
    await shown('[data-fs-part=md-toolbar]');
    let results = await axe.run(document.querySelector('[data-fs-part=md-viewer]') as HTMLElement);
    expect(results.violations.map(({ id, nodes }) => `${theme} ${id} ${nodes[0]?.html}`)).toEqual([]);
    await caretAtEndOf('Last line.');
    await userEvent.keyboard('{Enter}/');
    await shown('[data-fs-part=md-slash-menu]');
    results = await axe.run(document.querySelector('[data-fs-part=md-viewer]') as HTMLElement);
    expect(results.violations.map(({ id, nodes }) => `${theme} ${id} ${nodes[0]?.html}`)).toEqual([]);
    await screen.unmount();
  }
});
