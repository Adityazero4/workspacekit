import { createMemoryAdapter } from '@scope/core/memory';
import { Workspace } from '@scope/workspace';
import '@scope/workspace/styles.css';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { sampleFiles, simulateAgent } from '../src';

const FIRST_LOAD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

const treeRow = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role=treeitem]')].find(
    (row) => row.querySelector('[data-fs-part=tree-row-label]')?.textContent === name,
  );

async function openFile(path: string): Promise<void> {
  const segments = path.split('/');
  for (const [depth, segment] of segments.entries()) {
    await expect.poll(() => treeRow(segment)).toBeDefined();
    const row = treeRow(segment)!;
    if (depth < segments.length - 1) {
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
    } else row.click();
  }
}

const textIn = (selector: string, expected: string): boolean =>
  [...document.querySelectorAll(selector)].some((element) => element.textContent?.includes(expected));
const hasDecodedImage = (): boolean =>
  [...document.querySelectorAll<HTMLImageElement>('[data-fs-part=image-viewer] img')].some(
    (image) => image.naturalWidth > 0,
  );

const hasRenderedContent: Record<string, () => boolean> = {
  'README.md': () => textIn('[data-fs-part=md-viewer]', 'Demo project'),
  'package.json': () => textIn('.cm-line', '"name": "demo-project"'),
  'src/index.ts': () => textIn('.cm-line', 'export function greet'),
  'data/sales.csv': () => textIn('[data-fs-part=sheet-cell]', 'North'),
  'data/sales.xlsx': () => textIn('[data-fs-part=sheet-cell]', 'North'),
  'docs/welcome.pdf': () => document.querySelectorAll('.canvasWrapper canvas').length > 0,
  'assets/logo.svg': hasDecodedImage,
  'assets/gradient.png': hasDecodedImage,
};

test.each(Object.keys(hasRenderedContent))(
  '%s renders its content with no viewer error',
  async (path) => {
    await render(<Workspace adapter={createMemoryAdapter({ files: sampleFiles() })} />);
    await openFile(path);
    await expect.poll(hasRenderedContent[path]!, { timeout: FIRST_LOAD_TIMEOUT_MS }).toBe(true);
    expect(document.querySelector('[data-fs-part$=-error]')).toBeNull();
  },
  TEST_TIMEOUT_MS,
);

test('a file the agent creates shows the changed marker in the tree', async () => {
  const adapter = createMemoryAdapter({ files: sampleFiles() });
  await render(<Workspace adapter={adapter} />);
  await expect.poll(() => treeRow('README.md')).toBeDefined();
  const controller = new AbortController();
  simulateAgent(adapter, {
    signal: controller.signal,
    intervalMs: 1,
    script: [{ kind: 'create', path: 'agent-notes.md', content: '# Notes\n' }],
  });
  await expect.poll(() => treeRow('agent-notes.md')?.hasAttribute('data-changed')).toBe(true);
  expect(treeRow('README.md')?.hasAttribute('data-changed')).toBe(false);
  controller.abort();
});
