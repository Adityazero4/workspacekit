import { FsError, statusOf, type Entry, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, test } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { followMove } from '../src/actions/followMove';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { FileTabs } from '../src/tabs/FileTabs';
import { useTabs } from '../src/tabs/useTabs';
import { internalsOf } from '../src/provider/internals';
import { FileTree } from '../src/tree/FileTree';
import { FileViewer } from '../src/viewer/FileViewer';
import { lightRenderers, textRenderer } from '../src/viewer/lightRenderers';
import { defineRenderer } from '../src/viewer/registry';
import { useFileViewer } from '../src/viewer/useFileViewer';
import { SaveStatus } from '../src/editing/SaveStatus';
import { useAutosave } from '../src/editing/useAutosave';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';

const AFTER_AN_AUTOSAVE = { timeout: 4000 };
const ONE_POLLING_INTERVAL_AND_MARGIN = { timeout: 8000 };

interface Mounted {
  fs: FileSystemContext;
  memory: MemoryAdapter;
  unmount: () => Promise<void>;
}

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    props.onContext(fs);
  });
  return null;
}

function TabsWithViewer(): React.JSX.Element {
  const tabs = useTabs();
  return (
    <>
      <FileTabs />
      {tabs.active && <FileViewer path={tabs.active} renderers={lightRenderers} />}
    </>
  );
}

async function mount(
  files: Record<string, string>,
  children: ReactNode,
  adapt: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
): Promise<Mounted> {
  const memory = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  const screen = await render(
    <FileSystemProvider adapter={adapt(memory)}>
      <div style={{ height: 360, display: 'flex', flexDirection: 'column' }}>{children}</div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  return { fs: fs!, memory, unmount: () => screen.unmount() };
}

const mountViewer = (
  files: Record<string, string>,
  path = 'a.txt',
  adapt?: (memory: MemoryAdapter) => FileSystemAdapter,
): Promise<Mounted> => mount(files, <FileViewer path={path} renderers={lightRenderers} />, adapt);

const editor = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('[data-fs-part=text-editor]');
const saveStatus = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=viewer-save-status]');
const saveStatusText = (): string | null | undefined => saveStatus()?.textContent;
const saveBanner = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=save-banner]');
const buttonNamed = (container: Element | null, name: string): HTMLButtonElement => {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === name,
  );
  if (!found) throw new Error(`no button named ${name}`);
  return found;
};
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role=alertdialog]');
const tabNamed = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent === name,
  );
const tabNames = (): string[] =>
  [...document.querySelectorAll('[role=tab] [data-fs-part=tab-label]')].map(
    (label) => label.textContent ?? '',
  );

async function typeAtTheEnd(text: string): Promise<HTMLTextAreaElement> {
  await expect.poll(editor).not.toBeNull();
  const textarea = editor()!;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  await userEvent.keyboard(text);
  return textarea;
}

function failingWrites(memory: MemoryAdapter): { adapter: FileSystemAdapter; online: (on: boolean) => void } {
  let isOnline = false;
  return {
    adapter: {
      ...memory,
      write: (path, text, options) =>
        isOnline ? memory.write!(path, text, options) : Promise.reject(new FsError('network', 'offline')),
    },
    online: (on) => void (isOnline = on),
  };
}

test('agent writes during typing never drop or overwrite text', async () => {
  const { memory } = await mountViewer({ 'a.txt': 'start' });
  await expect.poll(() => editor()?.value).toBe('start');
  const textarea = await typeAtTheEnd(' h');
  let agentWrites = 0;
  const writeAsTheAgent = (): void => void memory.write!('a.txt', `agent version ${++agentWrites}`);
  writeAsTheAgent();
  const everyFewKeystrokes = setInterval(writeAsTheAgent, 200);
  try {
    await userEvent.keyboard('ello from the user');
    await expect.poll(saveBanner).not.toBeNull();
  } finally {
    clearInterval(everyFewKeystrokes);
  }
  expect(textarea.value).toBe('start hello from the user');
  expect(textarea.selectionStart).toBe(textarea.value.length);
  expect(document.activeElement).toBe(textarea);
  expect(saveBanner()!.getAttribute('role')).toBe('alert');
  await expect.poll(saveStatusText).toBe('Changed by someone else');
  expect(await memory.read('a.txt', 'text')).toBe(`agent version ${agentWrites}`);

  await userEvent.click(buttonNamed(saveBanner(), 'Keep mine'));
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('start hello from the user');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(saveBanner()).toBeNull();
  expect(editor()!.value).toBe('start hello from the user');

  await typeAtTheEnd('!');
  await memory.write!('a.txt', 'the agent has the last word');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Take theirs'));
  await expect.poll(() => editor()?.value).toBe('the agent has the last word');
  expect(saveBanner()).toBeNull();
  expect(await memory.read('a.txt', 'text')).toBe('the agent has the last word');
});

test('Take theirs resets the editor even when their text equals the text first loaded', async () => {
  const { memory } = await mountViewer({ 'a.txt': 'same' });
  await expect.poll(() => editor()?.value).toBe('same');
  const before = editor();
  await typeAtTheEnd(' and mine');
  await memory.write!('a.txt', 'same');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Take theirs'));
  await expect.poll(() => editor()?.value).toBe('same');
  expect(editor(), 'a fresh editor').not.toBe(before);
  await expect.poll(saveStatusText).toBe('');
  expect(await memory.read('a.txt', 'text')).toBe('same');
});

test('Keep mine keeps CRLF line endings', async () => {
  const { memory } = await mountViewer({ 'a.txt': 'one\r\ntwo' });
  await expect.poll(() => editor()?.value).toBe('one\ntwo');
  await typeAtTheEnd('{Enter}three');
  await memory.write!('a.txt', 'agent\r\ntext');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Keep mine'));
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('one\r\ntwo\r\nthree');
});

test('Save mine as a copy writes a free name next to the file and opens it', async () => {
  const { fs, memory } = await mount({ 'a.txt': 'original', 'a copy.txt': 'taken' }, <TabsWithViewer />);
  fs.tabs.set({ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' });
  await expect.poll(() => editor()?.value).toBe('original');
  await typeAtTheEnd(' plus mine');
  await memory.write!('a.txt', 'theirs');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Save mine as a copy'));
  await expect.poll(() => memory.read('a copy 2.txt', 'text')).toBe('original plus mine');
  await expect.poll(tabNames).toEqual(['a.txt', 'a copy 2.txt']);
  expect(fs.tabs.get().active).toBe('a copy 2.txt');
  fs.tabs.set((state) => ({ ...state, active: 'a.txt' }));
  await expect.poll(() => editor()?.value).toBe('theirs');
  expect(tabNamed('a.txt')!.hasAttribute('data-dirty')).toBe(false);
});

test('a dirty buffer follows a move and survives a delete', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { fs, memory } = await mount({ 'dir/a.txt': 'one' }, <TabsWithViewer />, (memory) => {
    const failing = failingWrites(memory);
    online = failing.online;
    return failing.adapter;
  });
  await fs.store.loadFolder('dir');
  fs.tabs.set({ tabs: [{ path: 'dir/a.txt', preview: false, dirty: false }], active: 'dir/a.txt' });
  await expect.poll(() => editor()?.value).toBe('one');
  await typeAtTheEnd(' two');
  await expect.poll(() => tabNamed('a.txt')?.hasAttribute('data-dirty')).toBe(true);

  await followMove(fs, 'dir', 'moved', () => fs.store.rename('dir', 'moved'));
  await expect.poll(() => fs.tabs.get().active).toBe('moved/a.txt');
  expect(editor()!.value).toBe('one two');
  expect(tabNamed('a.txt')!.hasAttribute('data-dirty')).toBe(true);

  await memory.delete!('moved/a.txt');
  await expect.poll(saveStatusText).toBe('Deleted');
  expect(saveBanner()!.textContent).toContain('deleted');
  expect(editor()!.value).toBe('one two');
  expect(tabNamed('a.txt')!.hasAttribute('data-deleted')).toBe(true);

  online(true);
  await userEvent.click(buttonNamed(saveBanner(), 'Save'));
  await expect.poll(() => memory.read('moved/a.txt', 'text')).toBe('one two');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(saveBanner()).toBeNull();
  await expect.poll(() => tabNamed('a.txt')?.hasAttribute('data-deleted')).toBe(false);
});

test('Discard on the deleted banner drops the edits and shows the file as deleted', async () => {
  const { memory } = await mountViewer(
    { 'a.txt': 'one' },
    'a.txt',
    (memory) => failingWrites(memory).adapter,
  );
  await expect.poll(() => editor()?.value).toBe('one');
  await typeAtTheEnd(' two');
  await memory.delete!('a.txt');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Discard'));
  await expect
    .poll(() => document.querySelector('[data-fs-part=viewer-error]')?.textContent)
    .toContain('deleted');
  expect(editor()).toBeNull();
});

test('closing a dirty tab offers Save, Discard and Cancel', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { fs, memory } = await mount({ 'a.txt': 'a', 'b.txt': 'b' }, <TabsWithViewer />, (memory) => {
    const failing = failingWrites(memory);
    online = failing.online;
    return failing.adapter;
  });
  fs.tabs.set({ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' });
  await expect.poll(() => editor()?.value).toBe('a');
  await typeAtTheEnd('1');
  await expect.poll(() => tabNamed('a.txt')?.hasAttribute('data-dirty')).toBe(true);

  tabNamed('a.txt')!.focus();
  await userEvent.keyboard('{Delete}');
  await expect.poll(dialog).not.toBeNull();
  expect([...dialog()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    'Cancel',
    'Discard',
    'Save',
  ]);
  await userEvent.click(buttonNamed(dialog(), 'Cancel'));
  await expect.poll(dialog).toBeNull();
  expect(tabNames()).toEqual(['a.txt']);
  expect(editor()!.value).toBe('a1');

  tabNamed('a.txt')!.focus();
  await userEvent.keyboard('{Delete}');
  await expect.poll(dialog).not.toBeNull();
  await userEvent.click(buttonNamed(dialog(), 'Save'));
  await expect.poll(() => dialog()?.querySelector('[role=alert]')?.textContent).toContain("Couldn't save");
  expect(tabNames(), 'a failed save keeps the tab').toEqual(['a.txt']);
  online(true);
  await userEvent.click(buttonNamed(dialog(), 'Save'));
  await expect.poll(tabNames).toEqual([]);
  expect(await memory.read('a.txt', 'text')).toBe('a1');

  fs.tabs.set({ tabs: [{ path: 'b.txt', preview: false, dirty: false }], active: 'b.txt' });
  await expect.poll(() => editor()?.value).toBe('b');
  online(false);
  await typeAtTheEnd('2');
  await expect.poll(() => tabNamed('b.txt')?.hasAttribute('data-dirty')).toBe(true);
  tabNamed('b.txt')!.focus();
  await userEvent.keyboard('{Delete}');
  await expect.poll(dialog).not.toBeNull();
  await userEvent.click(buttonNamed(dialog(), 'Discard'));
  await expect.poll(tabNames).toEqual([]);
  expect(await memory.read('b.txt', 'text')).toBe('b');
  fs.tabs.set({ tabs: [{ path: 'b.txt', preview: false, dirty: false }], active: 'b.txt' });
  await expect.poll(() => editor()?.value).toBe('b');
});

test('pagehide flushes; beforeunload asks while dirty', async () => {
  const writes: string[] = [];
  const { unmount } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => ({
    ...memory,
    write: (path, text, options) => {
      writes.push(text);
      return memory.write!(path, text, options);
    },
  }));
  await expect.poll(() => editor()?.value).toBe('a');
  const asksBeforeUnload = (): boolean =>
    !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  expect(asksBeforeUnload(), 'nothing to lose yet').toBe(false);

  await typeAtTheEnd('x');
  expect(asksBeforeUnload()).toBe(true);
  expect(writes).toEqual([]);
  window.dispatchEvent(new Event('pagehide'));
  expect(writes, 'the save starts during pagehide').toEqual(['ax']);
  await expect.poll(saveStatusText).toBe('Saved');
  expect(asksBeforeUnload()).toBe(false);

  await typeAtTheEnd('y');
  await unmount();
  expect(asksBeforeUnload(), 'the listeners leave with the provider').toBe(false);
});

test('an adapter without write keeps text read-only; with write it is editable', async () => {
  const withoutWrite = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => ({
    ...memory,
    write: undefined,
  }));
  await expect.poll(() => editor()?.value).toBe('a');
  expect(editor()!.readOnly).toBe(true);
  await withoutWrite.unmount();

  await mountViewer({ 'a.txt': 'a' });
  await expect.poll(() => editor()?.value).toBe('a');
  expect(editor()!.readOnly).toBe(false);
});

test('HTML is editable in source mode', async () => {
  const { memory } = await mountViewer({ 'page.html': '<p>hi</p>' }, 'page.html');
  await userEvent.click(buttonNamed(document.querySelector('[data-fs-part=viewer-modes]'), 'Source'));
  await expect.poll(() => editor()?.value).toBe('<p>hi</p>');
  await typeAtTheEnd('!');
  await expect.poll(() => memory.read('page.html', 'text'), AFTER_AN_AUTOSAVE).toBe('<p>hi</p>!');
});

test('only Saved and failures are announced; axe clean with the banner, light and dark', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { memory } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => {
    const failing = failingWrites(memory);
    online = failing.online;
    return failing.adapter;
  });
  online(true);
  await expect.poll(() => editor()?.value).toBe('a');
  const announcement = document.querySelector<HTMLElement>('[data-fs-part=save-announcement]')!;
  expect(announcement.getAttribute('role')).toBe('status');
  expect(announcement.getAttribute('aria-live')).toBe('polite');
  expect(saveStatus()!.hasAttribute('role')).toBe(false);
  expect(announcement.textContent).toBe('');

  await typeAtTheEnd('b');
  await expect.poll(saveStatusText).toBe('Unsaved');
  expect(announcement.textContent, 'typing is not announced').toBe('');
  await expect.poll(saveStatusText, AFTER_AN_AUTOSAVE).toBe('Saved');
  expect(announcement.textContent).toBe('Saved');

  online(false);
  await typeAtTheEnd('c');
  await expect.poll(saveStatusText, AFTER_AN_AUTOSAVE).toBe("Couldn't save. Retry");
  expect(announcement.textContent).toBe("Couldn't save.");

  await memory.write!('a.txt', 'theirs');
  await expect.poll(saveBanner).not.toBeNull();
  expect(saveBanner()!.getAttribute('role')).toBe('alert');
  await expect.poll(saveStatusText).toBe('Changed by someone else');
  expect(announcement.textContent, 'the alert banner announces the conflict').toBe('');
  expect(document.querySelector('[data-fs-part=save-announcement]'), 'the same live region').toBe(
    announcement,
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await cssTransitionsToSettle();
    const results = await axe.run(document.querySelector<HTMLElement>('[data-fs-part=viewer]')!);
    expect(
      results.violations.map((violation) => `${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
  await commands.emulateMedia({ colorScheme: null });
});

test('a failed save says so with Retry, and Retry saves', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { memory } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => {
    const failing = failingWrites(memory);
    online = failing.online;
    return failing.adapter;
  });
  await expect.poll(() => editor()?.value).toBe('a');
  await typeAtTheEnd('b');
  await expect.poll(saveStatusText, AFTER_AN_AUTOSAVE).toBe("Couldn't save. Retry");
  online(true);
  await userEvent.click(buttonNamed(saveStatus(), 'Retry'));
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('ab');
  await expect.poll(saveStatusText).toBe('Saved');
});

const rowNamed = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role=treeitem]')].find(
    (row) => row.querySelector('[data-fs-part=tree-row-label]')?.textContent === name,
  );

test("a save without watch is the user's own change: never marked, while an agent edit is", async () => {
  let rootPolls = 0;
  const { memory } = await mount(
    { 'a.txt': 'a', 'c.txt': 'c' },
    <>
      <FileTree style={{ height: 120 }} />
      <FileViewer path="a.txt" renderers={lightRenderers} />
    </>,
    (memory) => ({
      ...memory,
      watch: undefined,
      list: (path, options) => {
        if (path === '' && options.depth === 1) rootPolls++;
        return memory.list(path, options);
      },
    }),
  );
  const nextRootPoll = async (): Promise<void> => {
    const pollsSoFar = rootPolls;
    await expect.poll(() => rootPolls, ONE_POLLING_INTERVAL_AND_MARGIN).toBeGreaterThan(pollsSoFar);
  };
  await expect.poll(() => editor()?.value).toBe('a');
  await nextRootPoll();
  await typeAtTheEnd('b');
  await expect.poll(() => memory.read('a.txt', 'text'), AFTER_AN_AUTOSAVE).toBe('ab');
  await nextRootPoll();
  await memory.write!('c.txt', 'an agent edit');
  await expect
    .poll(() => rowNamed('c.txt')?.hasAttribute('data-changed'), ONE_POLLING_INTERVAL_AND_MARGIN)
    .toBe(true);
  expect(rowNamed('a.txt')!.hasAttribute('data-changed')).toBe(false);
  expect(saveBanner()).toBeNull();
  expect(saveStatusText()).toBe('Saved');
});

function CustomEditor(props: {
  save: (text: string, expectedMtimeMs: number | undefined) => Promise<Entry>;
}) {
  const [draft, setDraft] = useState('a');
  const { status } = useAutosave({ value: draft, save: props.save });
  return (
    <label>
      {status}
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  );
}

test('useAutosave saves a custom editor once typing pauses, and what is pending on unmount', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const writes: string[] = [];
  const save = (text: string, expectedMtimeMs: number | undefined): Promise<Entry> => {
    writes.push(text);
    return memory.write!('a.txt', text, { expectedMtimeMs });
  };
  const screen = await render(<CustomEditor save={save} />);
  const input = document.querySelector<HTMLInputElement>('input[aria-label=draft]')!;
  expect(input.parentElement!.textContent).toBe('idle');
  input.focus();
  await userEvent.keyboard('b');
  await expect.poll(() => input.parentElement!.textContent, AFTER_AN_AUTOSAVE).toBe('saved');
  expect(await memory.read('a.txt', 'text')).toBe('ab');

  await userEvent.keyboard('c');
  expect(writes).toEqual(['ab']);
  await screen.unmount();
  expect(writes, 'unmounting saves at once').toEqual(['ab', 'abc']);
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('abc');
});

function DraftOfTheViewedFile(props: { theirText: string; version: number | undefined }) {
  const { adapter } = useFileSystem();
  const [draft, setDraft] = useState(props.theirText);
  const autosave = useAutosave({
    value: draft,
    baseMtimeMs: props.version,
    save: (text, expectedMtimeMs) => adapter.write!('a.txt', text, { expectedMtimeMs }),
  });
  return (
    <div>
      <output aria-label="autosave">{autosave.status}</output>
      <textarea aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" onClick={() => void autosave.keepMine()}>
        Keep mine
      </button>
      <button
        type="button"
        onClick={() => {
          autosave.takeTheirs();
          setDraft(props.theirText);
        }}
      >
        Take theirs
      </button>
    </div>
  );
}

function CustomEditorOnTheViewer() {
  const viewer = useFileViewer('a.txt', { renderers: [textRenderer] });
  if (viewer.source?.kind !== 'text') return <p>Loading</p>;
  return <DraftOfTheViewedFile theirText={viewer.source.text} version={viewer.version} />;
}

test('useAutosave on useFileViewer never saves over an agent write; Take theirs and Keep mine resolve it', async () => {
  const { memory } = await mount({ 'a.txt': 'original' }, <CustomEditorOnTheViewer />);
  const draft = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label=draft]');
  const autosaveStatus = (): string | null | undefined =>
    document.querySelector('output[aria-label=autosave]')?.textContent;
  const typeInTheDraft = async (text: string): Promise<void> => {
    await expect.poll(draft).not.toBeNull();
    draft()!.focus();
    draft()!.setSelectionRange(draft()!.value.length, draft()!.value.length);
    await userEvent.keyboard(text);
  };
  await typeInTheDraft(' mine');
  await memory.write!('a.txt', 'agent');
  await expect.poll(autosaveStatus).toBe('conflict');
  expect(await memory.read('a.txt', 'text')).toBe('agent');

  await userEvent.click(buttonNamed(document.body, 'Take theirs'));
  expect(draft()!.value).toBe('agent');
  expect(autosaveStatus()).toBe('idle');
  await typeInTheDraft('!');
  await expect.poll(() => memory.read('a.txt', 'text'), AFTER_AN_AUTOSAVE).toBe('agent!');
  await expect.poll(autosaveStatus).toBe('saved');

  await typeInTheDraft(' mine again');
  await memory.write!('a.txt', 'agent again');
  await expect.poll(autosaveStatus).toBe('conflict');
  await userEvent.click(buttonNamed(document.body, 'Keep mine'));
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('agent! mine again');
  await expect.poll(autosaveStatus).toBe('saved');
});

function ViewerThatFollowsItsRename(props: { onRename: (rename: () => Promise<unknown>) => void }) {
  const fs = useFileSystem();
  const [path, setPath] = useState('a.txt');
  const { onRename } = props;
  useEffect(() =>
    onRename(() =>
      followMove(fs, 'a.txt', 'b.txt', async () => {
        const moved = await fs.store.rename('a.txt', 'b.txt');
        setPath('b.txt');
        return moved;
      }),
    ),
  );
  return <FileViewer path={path} renderers={lightRenderers} />;
}

test('a followed rename keeps the editor element and its focus, and saves what is typed meanwhile', async () => {
  let releaseMove = (): void => undefined;
  const moveHeld = new Promise<void>((resolve) => (releaseMove = resolve));
  let rename: () => Promise<unknown> = () => Promise.resolve();
  const { fs, memory } = await mount(
    { 'a.txt': 'hello' },
    <ViewerThatFollowsItsRename onRename={(renameFollowed) => void (rename = renameFollowed)} />,
    (memory) => ({
      ...memory,
      move: (from, to, options) => moveHeld.then(() => memory.move!(from, to, options)),
    }),
  );
  const textarea = await typeAtTheEnd(' one');
  const renamed = rename();
  await userEvent.keyboard(' two');
  releaseMove();
  await renamed;
  await expect.poll(() => document.querySelector('[data-fs-part=viewer-name]')?.textContent).toBe('b.txt');
  expect(editor()).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe('hello one two');
  await expect.poll(() => memory.read('b.txt', 'text'), AFTER_AN_AUTOSAVE).toBe('hello one two');
  await expect.poll(() => fs.hasUnsavedEdits()).toBe(false);
  expect(await memory.stat!('a.txt')).toBeNull();
});

test('a custom header gets the save state, and SaveStatus renders it with Retry', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { memory } = await mount(
    { 'a.txt': 'a' },
    <FileViewer
      path="a.txt"
      renderers={lightRenderers}
      renderHeader={(state, save) => (
        <header>
          <h2>{state.path}</h2>
          <SaveStatus status={save.status} onRetry={save.retry} />
          <span data-testid="save-error">{save.error?.kind}</span>
        </header>
      )}
    />,
    (memory) => {
      const failing = failingWrites(memory);
      online = failing.online;
      return failing.adapter;
    },
  );
  await typeAtTheEnd('b');
  await expect.poll(saveStatusText, AFTER_AN_AUTOSAVE).toBe("Couldn't save. Retry");
  expect(document.querySelector('[data-testid=save-error]')?.textContent).toBe('network');
  online(true);
  await userEvent.click(buttonNamed(saveStatus(), 'Retry'));
  await expect.poll(saveStatusText).toBe('Saved');
  expect(await memory.read('a.txt', 'text')).toBe('ab');
});

const viewerBody = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=viewer-body]');

async function conflictWhileTyping(memory: MemoryAdapter, typed: string): Promise<void> {
  await typeAtTheEnd(typed);
  await memory.write!('a.txt', 'theirs');
  await expect.poll(saveBanner).not.toBeNull();
}

test('from the click on Take theirs, the editor is read-only until their version shows', async () => {
  let holdTheNextStat = false;
  let releaseStat = (): void => undefined;
  const { memory } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => ({
    ...memory,
    stat: (path, options) => {
      if (!holdTheNextStat) return memory.stat!(path, options);
      holdTheNextStat = false;
      return new Promise((resolve) => (releaseStat = () => resolve(memory.stat!(path, options))));
    },
  }));
  await expect.poll(() => editor()?.value).toBe('a');
  await conflictWhileTyping(memory, 'b');
  holdTheNextStat = true;
  await userEvent.click(buttonNamed(saveBanner(), 'Take theirs'));
  await expect.poll(() => editor()?.readOnly).toBe(true);
  releaseStat();
  await expect.poll(() => editor()?.value).toBe('theirs');
  await expect.poll(() => editor()?.readOnly).toBe(false);
});

test('a dirty text file that grows past maxBytes keeps its editor', async () => {
  const smallTextRenderer = defineRenderer({ ...textRenderer, id: 'small-text', maxBytes: 20 });
  const { memory } = await mount(
    { 'a.txt': 'a' },
    <FileViewer path="a.txt" renderers={[smallTextRenderer]} />,
  );
  await expect.poll(() => editor()?.value).toBe('a');
  await conflictWhileTyping(memory, 'b');
  await memory.write!('a.txt', 'their text, far longer than twenty bytes');
  await expect.poll(saveStatusText).toBe('Changed by someone else');
  expect(editor()?.value).toBe('ab');
  expect(document.querySelector('[data-fs-part=viewer-error]')).toBeNull();
});

test('after Keep mine, Take theirs, Retry or Discard, focus goes to the editor or the viewer body', async () => {
  let online: (on: boolean) => void = () => undefined;
  const { memory } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => {
    const failing = failingWrites(memory);
    online = failing.online;
    return failing.adapter;
  });
  online(true);
  await expect.poll(() => editor()?.value).toBe('a');
  await conflictWhileTyping(memory, 'b');
  await userEvent.click(buttonNamed(saveBanner(), 'Keep mine'));
  await expect.poll(() => document.activeElement).toBe(editor());

  await conflictWhileTyping(memory, 'c');
  await userEvent.click(buttonNamed(saveBanner(), 'Take theirs'));
  await expect.poll(() => editor()?.value).toBe('theirs');
  await expect.poll(() => document.activeElement).toBe(editor());

  online(false);
  await typeAtTheEnd('d');
  await expect.poll(saveStatusText, AFTER_AN_AUTOSAVE).toBe("Couldn't save. Retry");
  online(true);
  await userEvent.click(buttonNamed(saveStatus(), 'Retry'));
  await expect.poll(saveStatusText).toBe('Saved');
  await expect.poll(() => document.activeElement).toBe(editor());

  online(false);
  await typeAtTheEnd('e');
  await memory.delete!('a.txt');
  await expect.poll(saveBanner).not.toBeNull();
  await userEvent.click(buttonNamed(saveBanner(), 'Discard'));
  await expect.poll(() => document.activeElement).toBe(viewerBody());
});

test('after Take theirs the file is read-only until their version has loaded', async () => {
  let holdReads = false;
  const heldReads: Array<() => void> = [];
  const { memory } = await mountViewer({ 'a.txt': 'a' }, 'a.txt', (memory) => ({
    ...memory,
    read: ((path: string, as: 'text') =>
      holdReads
        ? new Promise<string>((resolve) => heldReads.push(() => resolve(memory.read(path, as))))
        : memory.read(path, as)) as FileSystemAdapter['read'],
  }));
  await expect.poll(() => editor()?.value).toBe('a');
  await conflictWhileTyping(memory, ' mine');
  holdReads = true;
  await userEvent.click(buttonNamed(saveBanner(), 'Take theirs'));
  await expect.poll(() => heldReads.length).toBe(1);
  expect(editor()!.readOnly).toBe(true);
  holdReads = false;
  heldReads[0]!();
  await expect.poll(() => editor()?.value).toBe('theirs');
  expect(editor()!.readOnly).toBe(false);
});

test('Save mine as a copy opens the copy through onOpenEntry when the host gives one', async () => {
  const opened: string[] = [];
  const { fs, memory } = await mount(
    { 'a.txt': 'original' },
    <FileViewer path="a.txt" renderers={lightRenderers} onOpenEntry={(path) => opened.push(path)} />,
  );
  await expect.poll(() => editor()?.value).toBe('original');
  await conflictWhileTyping(memory, ' plus mine');
  await userEvent.click(buttonNamed(saveBanner(), 'Save mine as a copy'));
  await expect.poll(() => opened).toEqual(['a copy.txt']);
  expect(fs.tabs.get().tabs, 'the provider tabs are left to the host').toEqual([]);
  expect(await memory.read('a copy.txt', 'text')).toBe('original plus mine');
});

test('the close dialog shows that Save is in flight', async () => {
  let releaseWrite = (): void => undefined;
  const { fs } = await mount({ 'a.txt': 'a' }, <TabsWithViewer />, (memory) => ({
    ...memory,
    write: (path, text, options) =>
      new Promise((resolve) => (releaseWrite = () => resolve(memory.write!(path, text, options)))),
  }));
  fs.tabs.set({ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' });
  await expect.poll(() => editor()?.value).toBe('a');
  await typeAtTheEnd('1');
  tabNamed('a.txt')!.focus();
  await userEvent.keyboard('{Delete}');
  await expect.poll(dialog).not.toBeNull();
  await userEvent.click(buttonNamed(dialog(), 'Save'));
  await expect.poll(() => buttonNamed(dialog(), 'Saving…').getAttribute('aria-disabled')).toBe('true');
  expect(buttonNamed(dialog(), 'Discard').getAttribute('aria-disabled')).toBe('true');
  buttonNamed(dialog(), 'Discard').click();
  expect(internalsOf(fs).editBuffers.get('a.txt')?.text, 'answers wait for the save').toBe('a1');
  releaseWrite();
  await expect.poll(tabNames).toEqual([]);
});

test('hosts can guard navigation with hasUnsavedEdits, also after the tab closed', async () => {
  const { fs } = await mount({ 'a.txt': 'a' }, <TabsWithViewer />, (memory) => failingWrites(memory).adapter);
  const changes: boolean[] = [];
  fs.subscribeToEdits(() => changes.push(fs.hasUnsavedEdits()));
  fs.tabs.set({ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' });
  await expect.poll(() => editor()?.value).toBe('a');
  expect(fs.hasUnsavedEdits()).toBe(false);
  await typeAtTheEnd('1');
  expect(fs.hasUnsavedEdits()).toBe(true);
  expect(changes).toContain(true);
  fs.tabs.set({ tabs: [], active: null });
  await expect.poll(editor).toBeNull();
  expect(fs.hasUnsavedEdits()).toBe(true);
});

async function replacingMoveKeepsTheReplacedEdits(
  replace: (fs: FileSystemContext, memory: MemoryAdapter) => Promise<unknown>,
): Promise<void> {
  const { fs, memory } = await mount({ 'a.txt': 'A', 'b.txt': 'B' }, <TabsWithViewer />);
  const { editBuffers } = internalsOf(fs);
  const versionOf = async (path: string): Promise<number | undefined> => (await memory.stat!(path))?.mtimeMs;
  editBuffers.edit('a.txt', 'A edited', await versionOf('a.txt'));
  editBuffers.edit('b.txt', 'B with my unsaved work', await versionOf('b.txt'));
  await replace(fs, memory);
  await expect.poll(() => editBuffers.get('b copy.txt')?.text).toBe('B with my unsaved work');
  expect(editBuffers.get('b.txt')?.text).toBe('A edited');
  await expect.poll(() => tabNamed('b copy.txt')?.hasAttribute('data-dirty')).toBe(true);
  fs.tabs.set((state) => ({ ...state, active: 'b copy.txt' }));
  await expect.poll(() => editor()?.value).toBe('B with my unsaved work');
  expect(saveStatusText()).toBe('Deleted');
  await userEvent.click(buttonNamed(saveBanner(), 'Save'));
  await expect.poll(() => memory.read('b copy.txt', 'text')).toBe('B with my unsaved work');
  await expect.poll(saveStatusText).toBe('Saved');
}

test('a replacing move in the app keeps the replaced edits as an unsaved copy, which Save creates', async () => {
  await replacingMoveKeepsTheReplacedEdits((fs) =>
    followMove(fs, 'a.txt', 'b.txt', () => fs.store.move('a.txt', '', { overwrite: true, name: 'b.txt' })),
  );
});

test("an agent's replacing move keeps the replaced edits as an unsaved copy, which Save creates", async () => {
  await replacingMoveKeepsTheReplacedEdits((_fs, memory) =>
    memory.move!('a.txt', 'b.txt', { overwrite: true }),
  );
});
