import axe from 'axe-core';
import { FsError, statusOf, type Entry, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { afterEach, expect, test } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext, type Notice } from '../src/provider/hooks';
import { FileSearch } from '../src/search/FileSearch';
import { useFileSearch, type FileSearchState } from '../src/search/useFileSearch';
import { FileTree } from '../src/tree/FileTree';

const ROW_HEIGHT = 24;

function CaptureContext({ onContext }: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    onContext(fs);
  });
  return null;
}

interface Mounted {
  fs: FileSystemContext;
  notices: Notice[];
  opened: Entry[];
  unmount: () => Promise<void>;
}

const mount = async (
  adapter: FileSystemAdapter,
  options: { fetchDepth?: number; withTree?: boolean; treeStyle?: CSSProperties; search?: ReactNode } = {},
): Promise<Mounted> => {
  const notices: Notice[] = [];
  const opened: Entry[] = [];
  let captured: FileSystemContext | undefined;
  const screen = await render(
    <FileSystemProvider
      adapter={adapter}
      fetchDepth={options.fetchDepth}
      onNotify={(notice) => notices.push(notice)}
    >
      <input aria-label="outside" />
      {options.search ?? <FileSearch onOpenFile={(entry) => opened.push(entry)} />}
      {(options.withTree ?? true) && (
        <FileTree rowHeight={ROW_HEIGHT} style={{ height: 10 * ROW_HEIGHT, ...options.treeStyle }} />
      )}
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  return { fs: captured!, notices, opened, unmount: () => screen.unmount() };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[role=combobox]')!;
const optionLabels = (): string[] =>
  [...document.querySelectorAll('[role=option] [data-fs-part=search-result-name]')].map(
    (name) => name.textContent ?? '',
  );
const liveRegion = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=search-status]');
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const rowNamed = (name: string): HTMLElement | undefined =>
  rows().find((row) => row.querySelector('[data-fs-part=tree-row-label]')?.textContent === name);

afterEach(async () => {
  await commands.emulateMedia({ colorScheme: null });
});

interface SearchCall {
  query: string;
  signal: AbortSignal;
  calledAt: number;
}

const recordingSearches = (memory: MemoryAdapter, calls: SearchCall[]): FileSystemAdapter => ({
  ...memory,
  search: (query, opts) => {
    calls.push({ query, signal: opts!.signal!, calledAt: performance.now() });
    return memory.search!(query, opts);
  },
});

test('typing searches after 200 ms and aborts the previous request', async () => {
  const calls: SearchCall[] = [];
  const memory = createMemoryAdapter({ files: { 'readme.md': '', 'report.txt': '' }, latencyMs: 400 });
  await mount(recordingSearches(memory, calls));
  const typedAt = performance.now();
  await userEvent.fill(input(), 'r');
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.calledAt - typedAt, 'the request starts after the 200 ms pause').toBeGreaterThanOrEqual(
    199,
  );
  await userEvent.fill(input(), 're');
  expect(calls[0]!.signal.aborted, 'a new query aborts the request in flight').toBe(true);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toMatchObject({ query: 're' });
  expect(calls[1]!.signal.aborted).toBe(false);
  await expect.poll(optionLabels).toEqual(['readme.md', 'report.txt']);
});

test('stale results are never displayed', async () => {
  const memory = createMemoryAdapter({ files: { 'alpha.txt': '', 'abc.txt': '' } });
  const slowFirstFastSecond: FileSystemAdapter = {
    ...memory,
    search: async (query) => {
      await sleep(query === 'a' ? 600 : 20);
      return memory.search!(query);
    },
  };
  await mount(slowFirstFastSecond);
  await userEvent.fill(input(), 'a');
  await sleep(300);
  await userEvent.fill(input(), 'ab');
  await expect.poll(optionLabels).toEqual(['abc.txt']);
  await sleep(700);
  expect(optionLabels(), 'the slow answer for "a" arrived after "ab" and was ignored').toEqual(['abc.txt']);
});

test('matches are highlighted case- and NFC-insensitively', async () => {
  await mount(createMemoryAdapter({ files: { 'README.md': '', 'café.txt': '' } }));
  await userEvent.fill(input(), 'readme');
  await expect.poll(optionLabels).toEqual(['README.md']);
  const marks = (): string[] =>
    [...document.querySelectorAll('mark[data-fs-part=search-match]')].map((mark) => mark.textContent ?? '');
  expect(marks()).toEqual(['README']);
  await userEvent.fill(input(), 'CAFÉ');
  await expect.poll(optionLabels).toEqual(['café.txt']);
  expect(marks()).toEqual(['café']);
});

test('selecting a deep result reveals it', async () => {
  const memory = createMemoryAdapter({
    files: { 'a.txt': '', 'deep/one/two/three/target.txt': '', 'deep/one/two/three/other.txt': '' },
  });
  const listed: string[] = [];
  const recordingLists: FileSystemAdapter = {
    ...memory,
    list: (path, opts) => {
      listed.push(path);
      return memory.list(path, opts);
    },
  };
  const { opened } = await mount(recordingLists, { fetchDepth: 1 });
  await userEvent.click(input());
  await userEvent.fill(input(), 'target');
  await expect.poll(optionLabels).toEqual(['target.txt']);
  expect(input().getAttribute('aria-expanded')).toBe('true');
  expect(input().hasAttribute('aria-activedescendant'), 'no option is active yet').toBe(false);
  await userEvent.keyboard('{ArrowDown}');
  const option = document.querySelector('[role=option]')!;
  expect(input().getAttribute('aria-activedescendant')).toBe(option.id);
  expect(option.getAttribute('aria-selected')).toBe('true');
  await userEvent.keyboard('{Enter}');

  await expect.poll(() => rowNamed('target.txt')).toBeDefined();
  expect(listed.slice(1), 'every ancestor loaded once, top-down').toEqual([
    'deep',
    'deep/one',
    'deep/one/two',
    'deep/one/two/three',
  ]);
  for (const folder of ['deep', 'one', 'two', 'three']) {
    expect(rowNamed(folder)?.getAttribute('aria-expanded'), `${folder} is expanded`).toBe('true');
  }
  const target = rowNamed('target.txt')!;
  await expect.poll(() => document.activeElement).toBe(target);
  expect(target.getAttribute('aria-selected')).toBe('true');
  expect(target.hasAttribute('data-flash')).toBe(true);
  expect(opened.map((entry) => entry.path)).toEqual(['deep/one/two/three/target.txt']);
  await expect.poll(() => target.hasAttribute('data-flash'), { timeout: 3000 }).toBe(false);
});

test('a folder result reveals and expands the folder without opening anything', async () => {
  const { opened } = await mount(
    createMemoryAdapter({ files: { 'docs/guides/intro.md': '', 'b.txt': '' } }),
    { fetchDepth: 1 },
  );
  await userEvent.fill(input(), 'guides');
  await expect.poll(optionLabels).toEqual(['guides']);
  await userEvent.click(document.querySelector('[role=option]')!);
  await expect.poll(() => rowNamed('intro.md')).toBeDefined();
  expect(rowNamed('guides')!.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(rowNamed('guides'));
  expect(opened).toEqual([]);
});

test('ArrowUp and ArrowDown move the active option and wrap', async () => {
  await mount(createMemoryAdapter({ files: { 'n1.txt': '', 'n2.txt': '', 'n3.txt': '' } }));
  await userEvent.fill(input(), 'n');
  await expect.poll(optionLabels).toEqual(['n1.txt', 'n2.txt', 'n3.txt']);
  const activeLabel = (): string | undefined => {
    const id = input().getAttribute('aria-activedescendant');
    return id
      ? (document.getElementById(id)?.querySelector('[data-fs-part=search-result-name]')?.textContent ??
          undefined)
      : undefined;
  };
  await userEvent.keyboard('{ArrowUp}');
  expect(activeLabel()).toBe('n3.txt');
  await userEvent.keyboard('{ArrowDown}');
  expect(activeLabel()).toBe('n1.txt');
  await userEvent.keyboard('{ArrowDown}');
  expect(activeLabel()).toBe('n2.txt');
  expect(document.activeElement, 'focus stays in the input').toBe(input());
});

test('count is announced in a live region', async () => {
  await mount(createMemoryAdapter({ files: { 'one.txt': '', 'two.txt': '', 'three.md': '' } }));
  const region = liveRegion();
  expect(region, 'the live region is mounted before any results').not.toBeNull();
  expect(region!.getAttribute('aria-live')).toBe('polite');
  expect(region!.getAttribute('role')).toBe('status');
  await userEvent.fill(input(), 'txt');
  await expect.poll(() => region!.textContent).toBe('2 results');
  expect(liveRegion()).toBe(region);
  await userEvent.fill(input(), 'zzz');
  await expect.poll(() => region!.textContent).toBe('No results');
  await userEvent.fill(input(), 'one');
  await expect.poll(() => region!.textContent).toBe('1 result');
});

test('unsupported adapter renders nothing', async () => {
  const { search: _search, ...withoutSearch } = createMemoryAdapter({ files: { 'a.txt': '' } });
  await mount(withoutSearch);
  expect(document.querySelector('[data-fs-part=search]')).toBeNull();
  expect(document.querySelector('[role=combobox]')).toBeNull();
});

test('a failed search reports the error; an aborted one does not', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': '' } });
  const failing: FileSystemAdapter = {
    ...memory,
    search: async (query, opts) => {
      if (query === 'slow') {
        await sleep(300);
        if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      if (query === 'bad' || query === 'slow') throw new FsError('network', 'The search service is down.');
      return [];
    },
  };
  const { notices } = await mount(failing);
  await userEvent.fill(input(), 'slow');
  await sleep(250);
  await userEvent.fill(input(), '');
  await sleep(400);
  expect(notices, 'the aborted request reports nothing').toEqual([]);
  expect(liveRegion()!.textContent).toBe('');
  await userEvent.fill(input(), 'bad');
  await expect.poll(() => notices.length).toBe(1);
  expect(notices[0]).toMatchObject({ kind: 'error', error: { kind: 'network' } });
  expect(notices[0]!.message).toBe('Search failed: The search service is down. Try again.');
  expect(liveRegion()!.textContent).toBe('Search failed');
});

test('reveal of a missing path rejects with an actionable not_found error', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'docs/a.md': '' } }));
  await expect(fs.reveal('docs/missing/b.md')).rejects.toMatchObject({
    kind: 'not_found',
    path: 'docs/missing/b.md',
    message: expect.stringMatching(/docs\/missing.*does not exist/),
  });
});

test('concurrent reveals: the latest wins and the earlier one cannot steal focus', async () => {
  const memory = createMemoryAdapter({
    files: { 'slow/x/first.txt': '', 'fast/second.txt': '', 'top.txt': '' },
  });
  const slowFolder: FileSystemAdapter = {
    ...memory,
    list: async (path, opts) => {
      if (path === 'slow/x') await sleep(400);
      return memory.list(path, opts);
    },
  };
  const { fs } = await mount(slowFolder, { fetchDepth: 1 });
  const first = fs.reveal('slow/x/first.txt');
  const second = fs.reveal('fast/second.txt');
  await expect(second).resolves.toBeUndefined();
  await expect(first).rejects.toMatchObject({ kind: 'cancelled' });
  await expect.poll(() => document.activeElement).toBe(rowNamed('second.txt'));
  await sleep(500);
  expect(document.activeElement).toBe(rowNamed('second.txt'));
  expect(fs.selected.get()).toBe('fast/second.txt');
});

test('with no tree mounted, reveal still loads, expands and selects', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'a/b/c.txt': '' } }), {
    fetchDepth: 1,
    withTree: false,
  });
  await expect(fs.reveal('a/b/c.txt')).resolves.toBeUndefined();
  expect([...fs.expanded.get()].sort()).toEqual(['a', 'a/b']);
  expect(fs.selected.get()).toBe('a/b/c.txt');
});

test('axe: no violations with results open and one active, in light and dark', async () => {
  await mount(createMemoryAdapter({ files: { 'notes/today.md': '', 'todo.txt': '' } }));
  await userEvent.fill(input(), 'to');
  await expect.poll(optionLabels).toEqual(['today.md', 'todo.txt']);
  await userEvent.keyboard('{ArrowDown}');
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await expect.poll(() => matchMedia('(prefers-color-scheme: dark)').matches).toBe(colorScheme === 'dark');
    const results = await axe.run(document.querySelector<HTMLElement>('[data-fs-part=search]')!);
    expect(
      results.violations.map((violation) => `${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
});

const isRendered = (element: HTMLElement): boolean => {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

test('the live region stays in the accessibility tree and keeps its last announcement while searching', async () => {
  const memory = createMemoryAdapter({ files: { 'one.txt': '', 'two.txt': '' }, latencyMs: 300 });
  await mount(memory);
  const region = liveRegion()!;
  expect(isRendered(region), 'empty and idle').toBe(true);
  await userEvent.fill(input(), 'txt');
  expect(isRendered(region), 'searching').toBe(true);
  await expect.poll(() => region.textContent).toBe('2 results');
  await userEvent.fill(input(), 'one');
  await sleep(250);
  expect(region.textContent, 'the last announcement stays while the next search runs').toBe('2 results');
  expect(isRendered(region)).toBe(true);
  await expect.poll(() => region.textContent).toBe('1 result');
});

test('the previous results stay, marked searching, until the next answer lands', async () => {
  const memory = createMemoryAdapter({ files: { 'n1.txt': '', 'n2.txt': '' }, latencyMs: 300 });
  await mount(memory);
  await userEvent.fill(input(), 'n');
  await expect.poll(optionLabels).toEqual(['n1.txt', 'n2.txt']);
  await userEvent.fill(input(), 'n1');
  await sleep(100);
  expect(input().getAttribute('aria-expanded'), 'the listbox does not collapse on every keystroke').toBe(
    'true',
  );
  expect(optionLabels()).toEqual(['n1.txt', 'n2.txt']);
  await expect.poll(optionLabels).toEqual(['n1.txt']);
});

function SearchProbe({ onState }: { onState: (state: FileSearchState) => void }): null {
  const state = useFileSearch();
  useEffect(() => {
    onState(state);
  });
  return null;
}

test('the status is not done while a request for the same text is in flight', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': '', 'ab.txt': '' }, latencyMs: 300 });
  let latest: FileSearchState | undefined;
  await mount(memory, { search: <SearchProbe onState={(state) => (latest = state)} /> });
  latest!.setQuery('a');
  await expect.poll(() => latest!.status).toBe('done');
  latest!.setQuery('ab');
  await sleep(250);
  latest!.setQuery('a');
  await expect.poll(() => latest!.query).toBe('a');
  expect(latest!.status, 'a new request for "a" is pending').toBe('searching');
  await expect.poll(() => latest!.status).toBe('done');
});

test('unmounting aborts the request in flight', async () => {
  const calls: SearchCall[] = [];
  const memory = createMemoryAdapter({ files: { 'a.txt': '' }, latencyMs: 400 });
  const { unmount } = await mount(recordingSearches(memory, calls));
  await userEvent.fill(input(), 'a');
  await expect.poll(() => calls.length).toBe(1);
  await unmount();
  expect(calls[0]!.signal.aborted).toBe(true);
});

test('reveal reloads a stale folder once before reporting the entry missing', async () => {
  const memory = createMemoryAdapter({ files: { 'docs/old.md': '' } });
  const watchNeverEmits: FileSystemAdapter = { ...memory, watch: () => () => undefined };
  const { fs } = await mount(watchNeverEmits);
  await expect.poll(() => statusOf(fs.store.getSnapshot().tree, 'docs')).toBe('loaded');
  await memory.create!('docs/new.md', 'file');
  await expect(fs.reveal('docs/new.md')).resolves.toBeUndefined();
  expect(fs.selected.get()).toBe('docs/new.md');
  await expect(fs.reveal('docs/never.md')).rejects.toMatchObject({ kind: 'not_found' });
});

test('results under a hidden name are left out while Show hidden is off', async () => {
  const { fs } = await mount(
    createMemoryAdapter({ files: { 'node_modules/pkg/config.js': '', 'src/config.ts': '' } }),
  );
  await userEvent.fill(input(), 'config');
  await expect.poll(optionLabels).toEqual(['config.ts']);
  fs.showHidden.set(true);
  await expect.poll(optionLabels).toEqual(['config.js', 'config.ts']);
});

test('a reveal under a hidden name expands and selects, and never takes focus later', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { '.git/config': '', 'a.txt': '' } }));
  const outside = document.querySelector<HTMLInputElement>('[aria-label=outside]')!;
  outside.focus();
  await fs.reveal('.git/config');
  await fs.reveal('.git/config');
  expect(fs.expanded.get().has('.git')).toBe(true);
  expect(fs.selected.get()).toBe('.git/config');
  expect(fs.showHidden.get(), 'reveal never turns Show hidden on').toBe(false);
  await sleep(100);
  fs.showHidden.set(true);
  await expect.poll(() => rowNamed('config')).toBeDefined();
  await sleep(100);
  expect(document.activeElement).toBe(outside);
});

test('re-revealing the flashing row replays the flash', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'a.txt': '', 'b.txt': '' } }));
  await fs.reveal('b.txt', { flash: true });
  const row = rowNamed('b.txt')!;
  expect(row.hasAttribute('data-flash')).toBe(true);
  const flashChanges: boolean[] = [];
  const observer = new MutationObserver(() => flashChanges.push(row.hasAttribute('data-flash')));
  observer.observe(row, { attributes: true, attributeFilter: ['data-flash'] });
  await fs.reveal('b.txt', { flash: true });
  await expect.poll(() => flashChanges).toEqual([false, true]);
  observer.disconnect();
});

test('the flash lasts as long as --fs-flash-duration says', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'a.txt': '' } }), {
    treeStyle: { '--fs-flash-duration': '200ms' } as CSSProperties,
  });
  await fs.reveal('a.txt', { flash: true });
  const row = rowNamed('a.txt')!;
  expect(row.hasAttribute('data-flash')).toBe(true);
  await sleep(500);
  expect(row.hasAttribute('data-flash')).toBe(false);
});

test('reveal with expand opens a folder target too', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'docs/guide/intro.md': '' } }), {
    fetchDepth: 1,
  });
  await fs.reveal('docs/guide', { expand: true });
  expect([...fs.expanded.get()].sort()).toEqual(['docs', 'docs/guide']);
});

test('the listbox collapses when focus moves to the tree after a reveal, and reopens on focus', async () => {
  await mount(createMemoryAdapter({ files: { 'a.txt': '', 'ab.txt': '' } }));
  await userEvent.fill(input(), 'ab');
  await expect.poll(optionLabels).toEqual(['ab.txt']);
  await userEvent.keyboard('{ArrowDown}{Enter}');
  await expect.poll(() => document.activeElement).toBe(rowNamed('ab.txt'));
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector<HTMLElement>('[data-fs-part=search-viewport]')!.hidden).toBe(true);
  await userEvent.click(input());
  expect(input().getAttribute('aria-expanded')).toBe('true');
});

test('reveal marks the entry seen even with no tree mounted', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': '' } });
  const { fs } = await mount(memory, { withTree: false });
  memory.emit([{ type: 'updated', path: 'a.txt', actor: 'agent' }]);
  await expect.poll(() => fs.store.getSnapshot().changed.has('a.txt')).toBe(true);
  await fs.reveal('a.txt');
  expect(fs.store.getSnapshot().changed.has('a.txt')).toBe(false);
});

test('an invalid reveal does not cancel a valid one in flight', async () => {
  const memory = createMemoryAdapter({ files: { 'slow/a.txt': '' } });
  const slowFolder: FileSystemAdapter = {
    ...memory,
    list: async (path, opts) => {
      if (path === 'slow') await sleep(200);
      return memory.list(path, opts);
    },
  };
  const { fs } = await mount(slowFolder, { fetchDepth: 1 });
  const valid = fs.reveal('slow/a.txt');
  await expect(fs.reveal('')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(valid).resolves.toBeUndefined();
});

test('larger fonts grow the result rows instead of overlapping them', async () => {
  await mount(createMemoryAdapter({ files: { 'big1.txt': '', 'big2.txt': '', 'big3.txt': '' } }));
  document.querySelector<HTMLElement>('[data-fs-part=search]')!.style.setProperty('--fs-font-size', '40px');
  await userEvent.fill(input(), 'big');
  await expect.poll(optionLabels).toEqual(['big1.txt', 'big2.txt', 'big3.txt']);
  await sleep(100);
  const options = [...document.querySelectorAll<HTMLElement>('[role=option]')];
  for (const [at, option] of options.entries()) {
    expect(option.scrollHeight, `option ${at} holds its text`).toBeLessThanOrEqual(option.clientHeight);
    const nextTop = options[at + 1]?.getBoundingClientRect().top ?? Infinity;
    expect(
      option.getBoundingClientRect().bottom,
      `option ${at} ends before the next one`,
    ).toBeLessThanOrEqual(nextTop + 0.5);
  }
});

test('turning Show hidden off hides hidden results at once, without a new request', async () => {
  const calls: SearchCall[] = [];
  const memory = createMemoryAdapter({ files: { 'node_modules/pkg/config.js': '', 'src/config.ts': '' } });
  const { fs } = await mount(recordingSearches(memory, calls));
  fs.showHidden.set(true);
  await userEvent.fill(input(), 'config');
  await expect.poll(optionLabels).toEqual(['config.js', 'config.ts']);
  const requestsSoFar = calls.length;
  fs.showHidden.set(false);
  await expect.poll(optionLabels, { timeout: 150 }).toEqual(['config.ts']);
  await sleep(400);
  expect(calls, 'the filter runs on the answer already there').toHaveLength(requestsSoFar);
});

test('toggling Show hidden with no hidden results keeps the active option', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'k1.txt': '', 'k2.txt': '' } }));
  await userEvent.fill(input(), 'k');
  await expect.poll(optionLabels).toEqual(['k1.txt', 'k2.txt']);
  await userEvent.keyboard('{ArrowDown}');
  const active = input().getAttribute('aria-activedescendant');
  expect(active).not.toBeNull();
  fs.showHidden.set(true);
  await sleep(400);
  expect(input().getAttribute('aria-activedescendant')).toBe(active);
});

test('re-revealing the flashing row restarts its animation', async () => {
  const { fs } = await mount(createMemoryAdapter({ files: { 'a.txt': '', 'b.txt': '' } }));
  const flashStarts: EventTarget[] = [];
  const countFlashStarts = (event: AnimationEvent): void => {
    if (event.animationName === 'fs-flash') flashStarts.push(event.target!);
  };
  document.addEventListener('animationstart', countFlashStarts, true);
  await fs.reveal('b.txt', { flash: true });
  const row = rowNamed('b.txt')!;
  const flashAnimationTime = (): number => {
    const animation = row.getAnimations().find((each) => (each as CSSAnimation).animationName === 'fs-flash');
    return Number(animation?.currentTime ?? Infinity);
  };
  await sleep(400);
  const beforeReplay = flashAnimationTime();
  expect(beforeReplay).toBeGreaterThanOrEqual(300);
  await fs.reveal('b.txt', { flash: true });
  await sleep(50);
  expect(flashAnimationTime(), 'the replayed flash starts over instead of running on').toBeLessThan(
    beforeReplay,
  );
  await expect.poll(() => flashStarts.filter((target) => target === row).length).toBe(2);
  document.removeEventListener('animationstart', countFlashStarts, true);
});

test('a mousedown on the results list (scrollbar or empty space) keeps the input focused and the list open', async () => {
  await mount(createMemoryAdapter({ files: { 'm1.txt': '', 'm2.txt': '' } }));
  await userEvent.fill(input(), 'm');
  await expect.poll(optionLabels).toEqual(['m1.txt', 'm2.txt']);
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=search-viewport]')!;
  const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  viewport.dispatchEvent(mousedown);
  expect(mousedown.defaultPrevented, 'the browser does not move focus off the input').toBe(true);
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute('aria-expanded')).toBe('true');
});
