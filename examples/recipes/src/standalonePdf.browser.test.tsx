import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { blankPages, pdfBytes } from '../../../packages/pdf/test/fixtures/pdf';
import { StandalonePdfExample } from './standalonePdf';

const SLOW_PDF_WORK = { timeout: 15_000 };
const part = (name: string): HTMLElement | null => document.querySelector(`[data-fs-part=${name}]`);
const firstPageText = (): string | null | undefined => document.querySelector('.textLayer')?.textContent;
const drawnCanvases = (): number => document.querySelectorAll('.canvasWrapper canvas').length;

const bytes = pdfBytes({ pages: [{ text: 'Quarterly report' }, ...blankPages(1)] });

test('renders page 1 from bytes', async () => {
  await render(<StandalonePdfExample src={bytes} fileName="report.pdf" />);
  await expect.poll(() => part('pdf-page-indicator')?.textContent, SLOW_PDF_WORK).toBe('Page 1 of 2');
  await expect.poll(firstPageText, SLOW_PDF_WORK).toContain('Quarterly report');
  await expect.poll(drawnCanvases, SLOW_PDF_WORK).toBeGreaterThan(0);
});

test('renders page 1 from a local URL', async () => {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/pdf' }));
  try {
    await render(<StandalonePdfExample src={url} fileName="report.pdf" />);
    await expect.poll(() => part('pdf-page-indicator')?.textContent, SLOW_PDF_WORK).toBe('Page 1 of 2');
    await expect.poll(firstPageText, SLOW_PDF_WORK).toContain('Quarterly report');
  } finally {
    URL.revokeObjectURL(url);
  }
});
