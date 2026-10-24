// @vitest-environment node
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { renderToString } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { Workspace } from '../src/workspace/Workspace';

test('server rendering the workspace neither throws nor logs an error', () => {
  const errors = vi.spyOn(console, 'error');
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const html = renderToString(<Workspace adapter={adapter} storageKey="ws" theme="dark" defaultFollow />);
  expect(html).toContain('data-fs-part="workspace"');
  expect(html).toContain('data-theme="dark"');
  expect(html).toContain('role="separator"');
  expect(errors).not.toHaveBeenCalled();
});
