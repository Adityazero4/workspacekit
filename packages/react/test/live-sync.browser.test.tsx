import type { FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { afterEach, expect, test } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { internalsOf } from '../src/provider/internals';
import { FileTree } from '../src/tree/FileTree';
import { Workspace } from '../src/workspace/Workspace';

const FILES = {
  'a.txt': 'a',
  'c.txt': 'c',
  'src/two.ts': '2',
  'src/lib/one.ts': '1',
};
const ONE_POLLING_INTERVAL_AND_MARGIN = { timeout: 8000 };

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement | undefined => rows().find((row) => labelOf(row) === name);
const activeTabName = (): string | null | undefined =>
  document.querySelector('[role=tab][aria-selected=true]')?.querySelector('[data-fs-part=tab-label]')
    ?.textContent;
const markers = (name: string): string[] =>
  ['data-changed', 'data-changed-below'].filter((marker) => rowNamed(name)?.hasAttribute(marker));
const markerDotAnimations = (row: HTMLElement): Animation[] =>
  row
    .getAnimations({ subtree: true })
    .filter((animation) => (animation.effect as KeyframeEffect | null)?.pseudoElement === '::after');

afterEach(async () => {
  await commands.emulateMedia({ reducedMotion: null });
});

function withoutWatchRecordingPollingRounds(files: Record<string, string>) {
  const memory = createMemoryAdapter({ files });
  const { watch, emit, ...withoutWatch } = memory;
  const pollingRounds: string[][] = [];
  let currentRound: string[] | undefined;
  const adapter: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, options) => {
      if (options.depth === 1) {
        if (!currentRound) {
          pollingRounds.push((currentRound = []));
          queueMicrotask(() => (currentRound = undefined));
        }
        currentRound.push(path);
      }
      return withoutWatch.list(path, options);
    },
  };
  return { memory, adapter, pollingRounds };
}

test('without watch, an agent edit marks the file and its folders, and follow works', async () => {
  const { memory, adapter, pollingRounds } = withoutWatchRecordingPollingRounds(FILES);
  await render(<Workspace adapter={adapter} style={{ width: 900, height: 480 }} />);
  await expect.poll(() => rowNamed('src')).toBeDefined();
  await userEvent.click(rowNamed('src')!);
  await expect.poll(() => rowNamed('lib')).toBeDefined();
  await userEvent.click(rowNamed('lib')!);
  await userEvent.click(rowNamed('two.ts')!);
  await expect.poll(activeTabName).toBe('two.ts');

  await expect
    .poll(() => pollingRounds.at(-1), ONE_POLLING_INTERVAL_AND_MARGIN)
    .toEqual(['src', '', 'src/lib']);
  await memory.write!('src/lib/one.ts', 'an agent edit');

  await expect.poll(() => markers('one.ts'), ONE_POLLING_INTERVAL_AND_MARGIN).toEqual(['data-changed']);
  expect(markers('lib')).toEqual(['data-changed-below']);
  expect(markers('src')).toEqual(['data-changed-below']);
  expect(markers('two.ts')).toEqual([]);
  expect(markers('a.txt')).toEqual([]);

  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Follow agent changes"]')!);
  await memory.write!('c.txt', 'another agent edit');
  await expect.poll(activeTabName, ONE_POLLING_INTERVAL_AND_MARGIN).toBe('c.txt');
  expect(rowNamed('c.txt')!.getAttribute('aria-selected')).toBe('true');
});

function CaptureContext(props: { onContext: (fs: FileSystemContext) => void }): null {
  props.onContext(useFileSystem());
  return null;
}

test("without watch, the user's own upload is not marked while an agent edit in the same round is", async () => {
  const { memory, adapter, pollingRounds } = withoutWatchRecordingPollingRounds(FILES);
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={adapter}>
      <FileTree style={{ height: 240 }} />
      <CaptureContext onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => pollingRounds.at(-1), ONE_POLLING_INTERVAL_AND_MARGIN).toEqual(['']);

  await internalsOf(fs!).uploads.upload(
    [{ file: new File(['mine'], 'mine.txt'), relativePath: 'mine.txt' }],
    '',
  );
  await memory.write!('c.txt', 'an agent edit');

  await expect.poll(() => markers('c.txt'), ONE_POLLING_INTERVAL_AND_MARGIN).toEqual(['data-changed']);
  expect(rowNamed('mine.txt'), 'the upload is in the tree').toBeDefined();
  expect(markers('mine.txt')).toEqual([]);
});

async function mountTreeWithSrcOpen() {
  const adapter = createMemoryAdapter({ files: FILES });
  await render(
    <FileSystemProvider adapter={adapter}>
      <FileTree style={{ height: 240 }} />
    </FileSystemProvider>,
  );
  await expect.poll(() => rowNamed('src')).toBeDefined();
  await userEvent.click(rowNamed('src')!);
  await expect.poll(() => rowNamed('two.ts')).toBeDefined();
  return adapter;
}

test('the arrival animation plays once and not under reduced motion', async () => {
  const adapter = await mountTreeWithSrcOpen();
  adapter.emit([{ type: 'updated', path: 'src/two.ts', actor: 'external' }]);
  await expect.poll(() => markers('src')).toEqual(['data-changed-below']);
  const [arrival, ...others] = markerDotAnimations(rowNamed('src')!);
  expect(others).toEqual([]);
  expect((arrival as CSSAnimation).animationName).toBe('fs-marker-arrive');
  expect(arrival!.effect!.getComputedTiming().iterations).toBe(1);
  await arrival!.finished;

  adapter.emit([{ type: 'updated', path: 'src/lib', actor: 'external' }]);
  await expect.poll(() => markers('lib')).toEqual(['data-changed']);
  expect(markerDotAnimations(rowNamed('src')!), 'another change below does not replay it').toEqual([]);

  await commands.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  adapter.emit([{ type: 'updated', path: 'a.txt', actor: 'external' }]);
  await expect.poll(() => markers('a.txt')).toEqual(['data-changed']);
  expect(markerDotAnimations(rowNamed('a.txt')!)).toEqual([]);
});
