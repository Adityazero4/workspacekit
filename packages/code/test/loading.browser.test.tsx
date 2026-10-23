import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { CodeEditor } from '../src';

test('a status names the file while the editor code loads', async () => {
  const statuses: string[] = [];
  const observer = new MutationObserver(() => {
    const status = document.querySelector('[data-fs-part=code-loading]');
    if (status?.getAttribute('role') === 'status') statuses.push(status.textContent ?? '');
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await render(<CodeEditor value="a" fileName="a.ts" />);
    await expect.poll(() => document.querySelector('.cm-editor')).not.toBeNull();
  } finally {
    observer.disconnect();
  }
  expect(statuses).toContain('Opening a.ts…');
  expect(document.querySelector('[data-fs-part=code-loading]')).toBeNull();
});
