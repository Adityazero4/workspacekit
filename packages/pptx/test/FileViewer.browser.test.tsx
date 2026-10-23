import { statusOf } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import {
  FileSystemProvider,
  FileViewer,
  lightRenderers,
  useFileSystem,
  type FileSystemContext,
} from '@scope/react';
import '@scope/react/styles.css';
import { useEffect } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { PPTX_MAX_BYTES, pptxRenderer } from '../src';
import { pptxBytes, textShape } from './fixtures/pptx';

const FIRST_DRAW_TIMEOUT_MS = 5000;
const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';
const renderers = [
  pptxRenderer({ classNames: { 'pptx-viewer': 'my-pptx', 'pptx-slide': 'my-slide' } }),
  ...lightRenderers,
];

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

async function mountViewer(files: Record<string, string | Uint8Array>, path: string): Promise<void> {
  const memory = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={memory}>
      <div style={{ height: 500, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path={path} renderers={renderers} />
      </div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
}

const firstSlide = (): HTMLElement | null => document.querySelector('[data-fs-part=pptx-slide]');

test('the registry entry shows a .pptx from the adapter, with the factory classNames on its parts', async () => {
  await mountViewer(
    { 'decks/review.pptx': pptxBytes({ slides: [{ shapes: textShape('Quarterly review') }] }) },
    'decks/review.pptx',
  );
  await expect
    .poll(() => firstSlide()?.shadowRoot?.textContent, { timeout: FIRST_DRAW_TIMEOUT_MS })
    .toContain('Quarterly review');
  expect(document.querySelector('[data-fs-part=pptx-viewer]')!.className).toBe('my-pptx');
  expect(firstSlide()!.className).toBe('my-slide');
  expect(document.querySelector('[data-fs-part=pages-viewport]')!.getAttribute('aria-label')).toBe(
    'review.pptx',
  );
});

test('a .pptx that is not a zip shows load_error; one over maxBytes shows too_large', async () => {
  await mountViewer({ 'broken.pptx': 'not a zip' }, 'broken.pptx');
  await expect.poll(() => document.body.textContent).toContain(LOAD_ERROR_COPY);

  await mountViewer({ 'huge.pptx': new Uint8Array(PPTX_MAX_BYTES + 1) }, 'huge.pptx');
  await expect.poll(() => document.body.textContent).toContain(TOO_LARGE_COPY);
  expect(firstSlide()).toBeNull();
});
