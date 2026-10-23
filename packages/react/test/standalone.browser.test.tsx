import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { useStandaloneBytes, type StandaloneFile } from '../src/renderers/standalone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

type Loaded = StandaloneFile<{ data: ArrayBuffer }>;

// Mounts a component that loads a URL with `useStandaloneBytes`, waits for it to stop loading, and returns
// what it last showed.
async function loadFromUrl(response: Response): Promise<() => Loaded> {
  vi.stubGlobal('fetch', () => Promise.resolve(response));
  let shown: Loaded = { status: 'loading' };
  function Probe(): null {
    shown = useStandaloneBytes('https://example.test/file', undefined, { maxBytes: 1024 }).file;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await vi.waitFor(() => expect(shown.status).not.toBe('loading'));
  return () => shown;
}

test('a body that errors after one chunk is load_error, not too_large and not a hang', async () => {
  let chunkSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunkSent) controller.error(new Error('connection reset'));
      else controller.enqueue(new Uint8Array(10));
      chunkSent = true;
    },
  });
  const shown = (await loadFromUrl(new Response(body)))();
  expect(shown.status).toBe('error');
  if (shown.status === 'error') expect(shown.error.kind).toBe('load_error');
});

test('a response without a body is read as an empty file', async () => {
  const shown = (await loadFromUrl(new Response(null)))();
  expect(shown.status).toBe('ready');
  if (shown.status === 'ready') expect(shown.data.byteLength).toBe(0);
});
