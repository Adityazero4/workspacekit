import { createMemoryAdapter } from '@scope/core/memory';
import { FileSystemProvider, FileViewer, lightRenderers, resolveRenderer } from '@scope/react';
import '@scope/react/styles.css';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { logRenderer } from './customRenderer';

const renderers = [logRenderer(), ...lightRenderers];
const entryNamed = (name: string) => ({ path: name, name, kind: 'file' as const });

test('a .log file goes to the log renderer, other text stays with the text renderer', () => {
  expect(resolveRenderer(entryNamed('server.log'), renderers)?.id).toBe('log');
  expect(resolveRenderer(entryNamed('SERVER.LOG'), renderers)?.id).toBe('log');
  expect(resolveRenderer(entryNamed('notes.txt'), renderers)?.id).toBe('text');
  expect(resolveRenderer(entryNamed('log'), renderers)?.id).not.toBe('log');
});

test('the viewer highlights ERROR lines and leaves INFO lines plain', async () => {
  const adapter = createMemoryAdapter({
    files: { 'server.log': 'INFO started\nERROR disk full\nWARN slow\n' },
  });
  await render(
    <FileSystemProvider adapter={adapter}>
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path="server.log" renderers={renderers} />
      </div>
    </FileSystemProvider>,
  );
  await expect
    .poll(() => document.querySelector('[data-log-level=error]')?.textContent)
    .toBe('ERROR disk full');
  const error = document.querySelector<HTMLElement>('[data-log-level=error]')!;
  const info = document.querySelector<HTMLElement>('[data-log-level=info]')!;
  expect(error.querySelector('strong')).not.toBeNull();
  expect(info.querySelector('strong')).toBeNull();
  expect(getComputedStyle(error).color).not.toBe(getComputedStyle(info).color);
  expect(document.querySelector('[data-log-level=warn]')?.textContent).toBe('WARN slow');
});
