import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { PdfViewer } from '../src';
import { pdfBytes } from './fixtures/pdf';
import { trackWorkers, workerTraffic } from './support/trackedWorkers';

test('workerSrc replaces the default worker URL', async () => {
  trackWorkers();
  const workerSrc = new URL(workerUrl, location.href).href;
  await render(
    <div style={{ height: 400, display: 'flex' }}>
      <PdfViewer src={pdfBytes({ pages: [{ text: 'Own worker' }] })} workerSrc={workerSrc} />
    </div>,
  );
  await expect
    .poll(() => document.querySelector('.textLayer')?.textContent, { timeout: 15_000 })
    .toContain('Own worker');
  expect(workerTraffic.urls).toEqual([workerSrc]);
});
