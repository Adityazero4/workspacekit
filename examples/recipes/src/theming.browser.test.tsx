import { createMemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ThemedWorkspace } from './theming';

const part = (name: string): HTMLElement | null => document.querySelector(`[data-fs-part=${name}]`);
const accentOf = (element: HTMLElement): string =>
  getComputedStyle(element).getPropertyValue('--fs-accent').trim();
const FILES = { 'README.md': '# Hello\n', 'src/main.ts': 'export {};\n' };

test('the brand tokens replace the defaults, with a dark value under data-theme', async () => {
  const light = await render(
    <ThemedWorkspace adapter={createMemoryAdapter({ files: FILES })} theme="light" />,
  );
  await expect.poll(() => part('workspace')).not.toBeNull();
  expect(accentOf(part('workspace')!)).toBe('#6d28d9');
  expect(getComputedStyle(part('workspace')!).getPropertyValue('--fs-radius').trim()).toBe('10px');
  await light.unmount();
  await render(<ThemedWorkspace adapter={createMemoryAdapter({ files: FILES })} theme="dark" />);
  await expect.poll(() => part('workspace')).not.toBeNull();
  expect(accentOf(part('workspace')!)).toBe('#c4b5fd');
});

test('system follows prefers-color-scheme', async () => {
  await commands.emulateMedia({ colorScheme: 'dark' });
  await render(<ThemedWorkspace adapter={createMemoryAdapter({ files: FILES })} />);
  await expect.poll(() => part('workspace')).not.toBeNull();
  expect(accentOf(part('workspace')!)).toBe('#c4b5fd');
  await commands.emulateMedia({ colorScheme: null });
});

test('classNames adds a class to one part and keeps the part attribute', async () => {
  await render(<ThemedWorkspace adapter={createMemoryAdapter({ files: FILES })} theme="light" />);
  await expect.poll(() => part('workspace-files')).not.toBeNull();
  expect(part('workspace-files')!.classList.contains('brand-files')).toBe(true);
});

test('the EmptyState slot replaces the tree empty state', async () => {
  await render(<ThemedWorkspace adapter={createMemoryAdapter({ files: {} })} theme="light" />);
  await expect.poll(() => document.querySelector('[data-brand-empty]')).not.toBeNull();
  expect(document.querySelector('[data-brand-empty] strong')?.textContent).toBe('Nothing here yet');
  expect(part('tree-empty')?.contains(document.querySelector('[data-brand-empty]'))).toBe(true);
});

test.each(['light', 'dark'] as const)('axe finds no violations in the %s theme', async (scheme) => {
  await commands.emulateMedia({ colorScheme: scheme });
  await render(<ThemedWorkspace adapter={createMemoryAdapter({ files: FILES })} theme={scheme} />);
  await expect.poll(() => document.querySelector('[role=treeitem]')).not.toBeNull();
  const results = await axe.run(part('workspace')!);
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  await commands.emulateMedia({ colorScheme: null });
});
