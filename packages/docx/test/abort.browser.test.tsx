import type * as DocxPreview from 'docx-preview';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DocxViewer } from '../src';
import { docxBytes, paragraph } from './fixtures/docx';

const renders = vi.hoisted(() => {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { started: 0, gate, open };
});

vi.mock('docx-preview', async (importOriginal) => {
  const original = await importOriginal<typeof DocxPreview>();
  return {
    ...original,
    parseAsync: async (...args: Parameters<typeof original.parseAsync>) => {
      renders.started++;
      await renders.gate;
      return original.parseAsync(...args);
    },
  };
});

test('a source replaced while it renders is never mounted; only the current one is', async () => {
  const mountedTexts: string[] = [];
  const screen = await render(<DocxViewer src={docxBytes({ body: paragraph('First') })} />);
  await expect.poll(() => renders.started).toBe(1);
  const root = document.querySelector('[data-fs-part=docx-document]')!.shadowRoot!;
  new MutationObserver(() => mountedTexts.push(root.textContent ?? '')).observe(root, {
    childList: true,
    subtree: true,
  });

  await screen.rerender(<DocxViewer src={docxBytes({ body: paragraph('Second') })} />);
  await expect.poll(() => renders.started).toBe(2);
  renders.open();

  await expect.poll(() => root.textContent).toContain('Second');
  expect(mountedTexts.filter((text) => text.includes('First'))).toEqual([]);
});
