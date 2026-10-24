import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { MarkdownEditor } from '../src';
import type * as Transformers from '../src/transformers';

const POISON = 'makes the engine throw';

vi.mock('../src/transformers', async (importOriginal) => {
  const original = await importOriginal<typeof Transformers>();
  return {
    ...original,
    $importMarkdown: (body: string) => {
      if (body.includes(POISON)) throw new RangeError('Maximum call stack size exceeded');
      original.$importMarkdown(body);
    },
  };
});

afterEach(() => cleanup());

test('an import the engine throws on falls back to the source view with a notice, not an error', async () => {
  await render(
    <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <MarkdownEditor value={`# Title\n\n${POISON}\n`} fileName="a.md" onChange={() => {}} />
    </div>,
  );
  await expect
    .poll(() => document.querySelector('[data-fs-part=md-notice]')?.textContent)
    .toContain('shown as source');
  await expect.poll(() => document.querySelector('textarea')?.value).toBe(`# Title\n\n${POISON}\n`);
  expect(document.querySelector('[data-fs-part=md-editor]')).toBeNull();
});
