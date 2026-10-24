import { statusOf } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { EditorView } from '@codemirror/view';
import {
  FileSystemProvider,
  FileTabs,
  FileViewer,
  lightRenderers,
  useFileSystem,
  useTabs,
  type FileSystemContext,
} from '@workspacekit/react';
import '@workspacekit/react/styles.css';
import { useEffect } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { codeRenderer } from '../src';

const AFTER_AN_AUTOSAVE = { timeout: 4000 };
const renderers = [
  codeRenderer({ classNames: { 'code-viewer': 'my-viewer', 'code-editor': 'my-editor' } }),
  ...lightRenderers,
];

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

async function mount(
  files: Record<string, string>,
  viewer: React.JSX.Element,
): Promise<{ memory: MemoryAdapter; fs: FileSystemContext }> {
  const memory = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={memory}>
      <div style={{ height: 360, display: 'flex', flexDirection: 'column' }}>{viewer}</div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  return { memory, fs: fs! };
}

const mountViewer = async (files: Record<string, string>, path: string): Promise<MemoryAdapter> =>
  (await mount(files, <FileViewer path={path} renderers={renderers} />)).memory;

function TabsWithViewer(props: { onShortcut: (fs: FileSystemContext) => void }): React.JSX.Element {
  const tabs = useTabs();
  const fs = useFileSystem();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F2') props.onShortcut(fs);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  return (
    <>
      <FileTabs />
      {tabs.active && <FileViewer path={tabs.active} renderers={renderers} />}
    </>
  );
}

const editorView = (): EditorView | null => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
};
const placeCursor = async (view: EditorView, position: number): Promise<void> => {
  await userEvent.click(view.contentDOM, { position: { x: 4, y: 4 } });
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  await new Promise((resolve) => requestAnimationFrame(resolve));
};
const shownText = (): string | undefined => editorView()?.state.doc.toString();
const saveStatusText = (): string | null | undefined =>
  document.querySelector('[data-fs-part=viewer-save-status]')?.textContent;

test('edits flow to onChange and through Plan 3 buffers with autosave', async () => {
  const memory = await mountViewer({ 'src/a.ts': 'const a = 1;\r\nconst b = 2;\r\n' }, 'src/a.ts');
  await expect.poll(shownText).toBe('const a = 1;\nconst b = 2;\n');
  const view = editorView()!;
  expect(view.contentDOM.getAttribute('aria-label')).toBe('Contents of src/a.ts');
  expect(view.state.readOnly).toBe(false);

  await placeCursor(view, view.state.doc.line(1).to);
  await userEvent.keyboard(' // typed');
  await expect
    .poll(() => memory.read('src/a.ts', 'text'), AFTER_AN_AUTOSAVE)
    .toBe('const a = 1; // typed\r\nconst b = 2;\r\n');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(editorView(), 'the same editor').toBe(view);

  const cursor = view.state.selection.main.head;
  await memory.write!('src/a.ts', 'const a = 1; // typed\r\nconst b = 3;\r\n');
  await expect.poll(shownText).toBe('const a = 1; // typed\nconst b = 3;\n');
  expect(editorView(), 'updated in place').toBe(view);
  expect(view.state.selection.main.head).toBe(cursor);
  expect(view.hasFocus).toBe(true);
  expect(saveStatusText()).not.toBe('Unsaved changes');
});

test('an agent write while the user has unsaved edits leaves the editor alone and raises the conflict', async () => {
  const memory = await mountViewer({ 'a.json': '{}' }, 'a.json');
  await expect.poll(shownText).toBe('{}');
  const view = editorView()!;
  await placeCursor(view, 1);
  await userEvent.keyboard('"mine": 1');
  await memory.write!('a.json', '{"theirs": 2}');
  await expect.poll(() => document.querySelector('[data-fs-part=save-banner]')).not.toBeNull();
  expect(shownText()).toBe('{"mine": 1}');
});

test('Take theirs shows their text in a fresh editor', async () => {
  const memory = await mountViewer({ 'a.yaml': 'a: 1' }, 'a.yaml');
  await expect.poll(shownText).toBe('a: 1');
  const before = editorView()!;
  await placeCursor(before, 4);
  await userEvent.keyboard('0');
  await memory.write!('a.yaml', 'a: 2');
  await expect.poll(() => document.querySelector('[data-fs-part=save-banner]')).not.toBeNull();
  const takeTheirs = [...document.querySelectorAll('[data-fs-part=save-banner] button')].find(
    (button) => button.textContent === 'Take theirs',
  ) as HTMLButtonElement;
  await userEvent.click(takeTheirs);
  await expect.poll(shownText).toBe('a: 2');
  expect(editorView()).not.toBe(before);
  expect(await memory.read('a.yaml', 'text')).toBe('a: 2');
});

test('the factory classNames land on the code parts in the FileViewer path', async () => {
  await mountViewer({ 'a.ts': 'const a = 1;' }, 'a.ts');
  await expect.poll(shownText).toBe('const a = 1;');
  expect(document.querySelector('[data-fs-part=code-editor]')!.classList.contains('my-editor')).toBe(true);
  expect(document.querySelector('[data-fs-part=code-viewer]')!.classList.contains('my-viewer')).toBe(true);
});

const OVER_ONE_MEBIBYTE = 'const line = "an agent wrote this line";\n'.repeat(30_000);

test.each([
  [
    'switching to another tab',
    (fs: FileSystemContext) => fs.tabs.set((tabs) => ({ ...tabs, active: 'small.ts' })),
  ],
  ['closing every tab', (fs: FileSystemContext) => fs.tabs.set({ tabs: [], active: null })],
])(
  'an edit over 1 MiB still pending when a keyboard shortcut unmounts the editor (%s) is saved',
  async (_, shortcut) => {
    const { memory, fs } = await mount(
      { 'big.ts': OVER_ONE_MEBIBYTE, 'small.ts': 'small' },
      <TabsWithViewer onShortcut={shortcut} />,
    );
    fs.tabs.set({
      tabs: [
        { path: 'big.ts', preview: false, dirty: false },
        { path: 'small.ts', preview: false, dirty: false },
      ],
      active: 'big.ts',
    });
    await expect.poll(() => shownText()?.length).toBe(OVER_ONE_MEBIBYTE.length);
    await placeCursor(editorView()!, 0);
    await userEvent.keyboard('A{F2}');
    await expect.poll(() => memory.read('big.ts', 'text'), AFTER_AN_AUTOSAVE).toBe(`A${OVER_ONE_MEBIBYTE}`);
  },
);
