import { undo } from '@codemirror/commands';
import { language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import '@workspacekit/react/styles.css';
import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { CodeEditor, CodeViewer, type CodeEditorProps } from '../src';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MODIFIER = /Mac/.test(navigator.platform) ? 'Meta' : 'Control';

const editorView = (): EditorView | null => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
};
const shownView = async (): Promise<EditorView> => {
  await expect.poll(editorView).not.toBeNull();
  return editorView()!;
};
const languageName = (): string | undefined => editorView()?.state.facet(language)?.name;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const placeCursor = async (view: EditorView, position: number): Promise<void> => {
  await userEvent.click(view.contentDOM, { position: { x: 4, y: 4 } });
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  await nextFrame();
};

function Sized(props: CodeEditorProps): React.JSX.Element {
  return (
    <div style={{ height: 200, display: 'flex', flexDirection: 'column' }}>
      <CodeEditor {...props} />
    </div>
  );
}

test('remote update keeps selection and scroll and stays out of undo', async () => {
  const original = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
  const onChange = vi.fn<(text: string) => void>();
  const screen = await render(<Sized value={original} onChange={onChange} fileName="notes.log" />);
  const view = await shownView();
  await placeCursor(view, view.state.doc.line(301).to);
  await userEvent.keyboard('X');
  const typed = original.replace('line 300', 'line 300X');
  await expect.poll(() => onChange.mock.lastCall?.[0]).toBe(typed);
  await screen.rerender(<Sized value={typed} onChange={onChange} fileName="notes.log" />);
  view.scrollDOM.scrollTop = 3000;
  await nextFrame();
  const { scrollTop } = view.scrollDOM;
  const cursor = view.state.selection.main.head;
  const changes = onChange.mock.calls.length;

  const remote = typed.replace('line 10\n', 'line 10 edited by an agent\n');
  await screen.rerender(<Sized value={remote} onChange={onChange} fileName="notes.log" />);
  await nextFrame();
  await nextFrame();
  expect(view.state.doc.toString()).toBe(remote);
  expect(view.state.selection.main.head).toBe(cursor + ' edited by an agent'.length);
  expect(view.scrollDOM.scrollTop).toBe(scrollTop);
  expect(view.hasFocus).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(changes);

  undo(view);
  expect(view.state.doc.toString()).toBe(remote.replace('line 300X', 'line 300'));
  expect(onChange.mock.lastCall?.[0]).toBe(remote.replace('line 300X', 'line 300'));
});

test('a new value is not applied over edits the editor has not reported yet', async () => {
  const onChange = vi.fn<(text: string) => void>();
  const screen = await render(<Sized value="start" onChange={onChange} fileName="a.txt" />);
  const view = await shownView();
  await placeCursor(view, 5);
  await userEvent.keyboard('ed');
  await screen.rerender(<Sized value="starte" onChange={onChange} fileName="a.txt" />);
  expect(view.state.doc.toString()).toBe('started');
});

test('edits keep CRLF line endings and are reported only for user edits', async () => {
  const onChange = vi.fn<(text: string) => void>();
  await render(<Sized value={'one\r\ntwo\r\n'} onChange={onChange} fileName="a.ts" />);
  const view = await shownView();
  expect(view.state.doc.lines).toBe(3);
  expect(onChange).not.toHaveBeenCalled();
  await placeCursor(view, 3);
  await userEvent.keyboard('{Enter}1');
  await expect.poll(() => onChange.mock.lastCall?.[0]).toBe('one\r\n1\r\ntwo\r\n');
});

test('read-only blocks edits but allows select and copy', async () => {
  const onChange = vi.fn<(text: string) => void>();
  const text = 'const a = 1;\nconst b = 2;';
  await render(<Sized value={text} readOnly onChange={onChange} fileName="a.ts" />);
  const view = await shownView();
  const content = view.contentDOM;
  expect(content.getAttribute('contenteditable')).toBe('false');
  expect(content.getAttribute('aria-readonly')).toBe('true');
  expect(content.getAttribute('aria-label')).toBe('Contents of a.ts');
  content.focus();
  expect(document.activeElement).toBe(content);

  await userEvent.keyboard('abc{Backspace}{Enter}');
  expect(view.state.doc.toString()).toBe(text);
  expect(onChange).not.toHaveBeenCalled();

  await userEvent.keyboard(`{${MODIFIER}>}a{/${MODIFIER}}`);
  expect(view.state.selection.main).toMatchObject({ from: 0, to: text.length });
  const copy = new ClipboardEvent('copy', {
    clipboardData: new DataTransfer(),
    bubbles: true,
    cancelable: true,
  });
  content.dispatchEvent(copy);
  expect(copy.defaultPrevented, 'CodeMirror put the selection on the clipboard').toBe(true);
});

test('the editor is named after the file and Tab moves focus out of it', async () => {
  await render(
    <>
      <Sized value="a" onChange={() => {}} fileName="src/a.ts" />
      <input aria-label="after the editor" />
    </>,
  );
  const view = await shownView();
  expect(view.contentDOM.getAttribute('aria-label')).toBe('Contents of src/a.ts');
  view.focus();
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('after the editor');
  expect(view.state.doc.toString()).toBe('a');
});

const JAVASCRIPT_SAMPLE = [
  '// greets someone',
  'class Greeter extends Base {}',
  'function greet(name) {',
  '  return `hi ${name}` + 42 * count;',
  '}',
  'greet("you");',
].join('\n');

const resolvedColor = (inside: Element, value: string): string => {
  const probe = document.createElement('span');
  probe.style.color = value;
  inside.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};

const tokenNamed = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.cm-line span')].find((span) => span.textContent === text);

test('theme follows data-theme via CSS variables; axe clean light and dark', async () => {
  const screen = await render(<Sized value={JAVASCRIPT_SAMPLE} fileName="greet.js" theme="light" />);
  const view = await shownView();
  await expect.poll(() => tokenNamed('class')).toBeDefined();
  for (const theme of ['light', 'dark'] as const) {
    await screen.rerender(<Sized value={JAVASCRIPT_SAMPLE} fileName="greet.js" theme={theme} />);
    expect(editorView()).toBe(view);
    const root = document.querySelector('[data-fs-part=code-viewer]')!;
    expect(root.getAttribute('data-theme')).toBe(theme);
    expect(getComputedStyle(view.dom).backgroundColor).toBe(resolvedColor(root, 'var(--fs-bg)'));
    expect(getComputedStyle(tokenNamed('class')!).color).toBe(
      resolvedColor(root, 'var(--fs-syntax-keyword)'),
    );
    expect(getComputedStyle(tokenNamed('42')!).color).toBe(resolvedColor(root, 'var(--fs-syntax-number)'));
    const results = await axe.run(root as HTMLElement);
    expect(results.violations.map(({ id, nodes }) => `${theme} ${id} ${nodes[0]?.html}`)).toEqual([]);
  }
});

test('HTML tags and attributes are themed and pass axe in both themes', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const screen = await render(
      <Sized value={'<a href="/home" class="x">Home</a>'} fileName="nav.svelte" theme={theme} />,
    );
    await expect.poll(() => tokenNamed('href')).toBeDefined();
    const root = document.querySelector('[data-fs-part=code-viewer]')!;
    expect(getComputedStyle(tokenNamed('href')!).color).toBe(
      resolvedColor(root, 'var(--fs-syntax-attribute)'),
    );
    expect(getComputedStyle(tokenNamed('a')!).color).toBe(resolvedColor(root, 'var(--fs-syntax-tag)'));
    const results = await axe.run(root as HTMLElement);
    expect(results.violations.map(({ id, nodes }) => `${theme} ${id} ${nodes[0]?.html}`)).toEqual([]);
    await screen.unmount();
  }
});

test('the language loads lazily and stale loads are dropped', async () => {
  const python = languages.find((description) => description.name === 'Python')!;
  let releasePython!: () => void;
  const pythonHeld = new Promise<void>((resolve) => (releasePython = resolve));
  const loadPython = python.load.bind(python);
  vi.spyOn(python, 'load').mockImplementation(() => pythonHeld.then(loadPython));

  const screen = await render(<Sized value="x = 1" language="python" />);
  await shownView();
  expect(languageName()).toBeUndefined();
  await screen.rerender(<Sized value="x = 1" language="css" />);
  await expect.poll(languageName).toBe('css');

  releasePython();
  await loadPython();
  await nextFrame();
  expect(languageName()).toBe('css');
});

test('a document over 1 MiB reports edits after a pause, and at once on blur and on unmount', async () => {
  const big = Array.from({ length: 20_000 }, (_, index) => `line ${index} `.padEnd(60, '.')).join('\n');
  const onChange = vi.fn<(text: string) => void>();
  const screen = await render(
    <>
      <Sized value={big} onChange={onChange} fileName="big.log" />
      <input aria-label="elsewhere" />
    </>,
  );
  const view = await shownView();
  await placeCursor(view, 0);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await userEvent.keyboard('A');
  expect(view.state.doc.sliceString(0, 1)).toBe('A');
  expect(onChange).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(onChange).toHaveBeenLastCalledWith(`A${big}`);
  vi.useRealTimers();

  await userEvent.keyboard('B');
  expect(onChange).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLInputElement>('[aria-label=elsewhere]')!.focus();
  await expect.poll(() => onChange.mock.lastCall?.[0]).toBe(`AB${big}`);

  view.focus();
  await userEvent.keyboard('C');
  expect(onChange).toHaveBeenCalledTimes(2);
  await screen.unmount();
  expect(onChange).toHaveBeenLastCalledWith(`ABC${big}`);
});

test('an edit reported after a pause goes to the onChange current when it was typed', async () => {
  const big = 'x'.repeat(1024 * 1024 + 1);
  const whenTyped = vi.fn<(text: string) => void>();
  const afterARemoteVersion = vi.fn<(text: string) => void>();
  const screen = await render(<Sized value={big} onChange={whenTyped} fileName="big.log" />);
  const view = await shownView();
  await placeCursor(view, 0);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await userEvent.keyboard('A');
  await screen.rerender(<Sized value={big} onChange={afterARemoteVersion} fileName="big.log" />);
  vi.advanceTimersByTime(1000);
  expect(whenTyped).toHaveBeenCalledWith(`A${big}`);
  expect(afterARemoteVersion).not.toHaveBeenCalled();
});

test('CodeViewer shows a file read-only, named after it', async () => {
  const bytes = new TextEncoder().encode('SELECT 1;');
  await render(
    <div style={{ height: 200, display: 'flex' }}>
      <CodeViewer src={bytes} fileName="query.sql" />
    </div>,
  );
  const view = await shownView();
  expect(view.state.doc.toString()).toBe('SELECT 1;');
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM.getAttribute('aria-label')).toBe('Contents of query.sql');
  await expect.poll(languageName).toBe('sql');
});

const OVER_ONE_MEBIBYTE = 'x'.repeat(1024 * 1024 + 1);

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

test.each([
  ['the page is hidden', () => window.dispatchEvent(new Event('pagehide'))],
  ['the tab becomes hidden', () => setVisibility('hidden')],
])('an edit over 1 MiB still pending is reported at once when %s', async (_, leave) => {
  const onChange = vi.fn<(text: string) => void>();
  await render(<Sized value={OVER_ONE_MEBIBYTE} onChange={onChange} fileName="big.log" />);
  const view = await shownView();
  await placeCursor(view, 0);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await userEvent.keyboard('A');
  expect(onChange).not.toHaveBeenCalled();
  try {
    leave();
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
  expect(onChange).toHaveBeenCalledExactlyOnceWith(`A${OVER_ONE_MEBIBYTE}`);
});

test('the cursor does not blink under prefers-reduced-motion', async () => {
  const blinkDuration = async (): Promise<string> => {
    const screen = await render(<Sized value="a" onChange={() => {}} fileName="a.ts" />);
    const view = await shownView();
    const duration = view.dom.querySelector<HTMLElement>('.cm-cursorLayer')!.style.animationDuration;
    await screen.unmount();
    return duration;
  };
  expect(await blinkDuration()).not.toBe('0ms');
  try {
    await commands.emulateMedia({ reducedMotion: 'reduce' });
    expect(await blinkDuration()).toBe('0ms');
  } finally {
    await commands.emulateMedia({ reducedMotion: null });
  }
});

test('CodeViewer refuses a file over 10 MiB as too_large without reading it', async () => {
  const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
  const onError = vi.fn();
  await render(
    <CodeViewer
      src={new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])}
      fileName="huge.json"
      onError={onError}
    />,
  );
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'too_large' });
  expect(document.querySelector('[data-fs-part=code-error]')?.getAttribute('role')).toBe('alert');
  expect(read).not.toHaveBeenCalled();
  expect(editorView()).toBeNull();
});
