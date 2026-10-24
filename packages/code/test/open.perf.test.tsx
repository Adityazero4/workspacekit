import { statusOf, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { EditorView } from '@codemirror/view';
import {
  FileSystemProvider,
  FileViewer,
  lightRenderers,
  useFileSystem,
  type FileSystemContext,
} from '@workspacekit/react';
import '@workspacekit/react/styles.css';
import { useEffect } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { codeRenderer } from '../src';

const MEBIBYTE = 1024 * 1024;
const LARGE_FILE = 'large.ts';
const WARM_UP_RUNS = 1;
const MEDIAN_RUNS = 5;
const BUDGET_MS = 200 * Number(process.env.PERF_BUDGET_SCALE);
const renderers = [codeRenderer(), ...lightRenderers];

const oneMebibyteOfCode = (): string =>
  'export const answer = computeTheAnswer(42, "an agent wrote this");\n'
    .repeat(MEBIBYTE / 64)
    .slice(0, MEBIBYTE);

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const afterNextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

function recordingWhenTheBytesArrive(text: string): { adapter: FileSystemAdapter; arrivedAt: () => number } {
  const memory = createMemoryAdapter({ files: { [LARGE_FILE]: text } });
  let arrivedAt = Number.NaN;
  const read = (async (path: string, as: 'text', options) => {
    const read = await memory.read(path, as, options);
    if (path === LARGE_FILE) arrivedAt = performance.now();
    return read;
  }) as FileSystemAdapter['read'];
  return { adapter: { ...memory, read }, arrivedAt: () => arrivedAt };
}

async function untilEditable(length: number): Promise<void> {
  for (;;) {
    const editor = document.querySelector<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (view && !view.state.readOnly && view.state.doc.length === length) return;
    await nextFrame();
  }
}

async function openToEditableMs(text: string): Promise<number> {
  const { adapter, arrivedAt } = recordingWhenTheBytesArrive(text);
  let fs: FileSystemContext | undefined;
  const screen = await render(
    <FileSystemProvider adapter={adapter}>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  await screen.rerender(
    <FileSystemProvider adapter={adapter}>
      <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path={LARGE_FILE} renderers={renderers} />
      </div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await untilEditable(text.length);
  await afterNextPaint();
  const elapsed = performance.now() - arrivedAt();
  await screen.unmount();
  return elapsed;
}

test(`a 1 MiB file opens into an editable view within ${BUDGET_MS} ms of its bytes arriving (median of ${MEDIAN_RUNS} after ${WARM_UP_RUNS} warm-up)`, async () => {
  const text = oneMebibyteOfCode();
  await renderers[0]!.load();
  const samples: number[] = [];
  for (let attempt = 0; attempt < WARM_UP_RUNS + MEDIAN_RUNS; attempt++) {
    (globalThis as { gc?: () => void }).gc?.();
    const sample = await openToEditableMs(text);
    if (attempt >= WARM_UP_RUNS) samples.push(sample);
  }
  const message = `code open to editable: median of [${samples.map((sample) => sample.toFixed(1)).join(', ')}]`;
  // eslint-disable-next-line no-console -- the perf project prints every budget's raw samples (Ruling P3-20)
  console.info(`[perf] ${message} = ${median(samples).toFixed(1)}, budget ≤ ${BUDGET_MS}`);
  expect(median(samples), message).toBeLessThanOrEqual(BUDGET_MS);
});
