import { afterAll, beforeAll, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import type * as PdfPackage from '../src';
import { pdfBytes } from './fixtures/pdf';
import { trackWorkers, workerTraffic } from './support/trackedWorkers';

type PromiseStatics = PromiseConstructor & { withResolvers?: unknown };
const BUILT_ENTRY = '../dist/index.js';
const { PdfViewer } = (await import(BUILT_ENTRY)) as typeof PdfPackage;
const statics: PromiseStatics = Promise;
const nativeWithResolvers = statics.withResolvers;

beforeAll(() => {
  delete statics.withResolvers;
  trackWorkers();
});

afterAll(() => {
  Object.defineProperty(Promise, 'withResolvers', {
    value: nativeWithResolvers,
    writable: true,
    configurable: true,
  });
});

test('the built package opens a PDF where Promise.withResolvers is missing (Chrome 105-118, Safari 15.4-17.3)', async () => {
  expect(statics.withResolvers).toBeUndefined();
  await render(
    <div style={{ height: 400, display: 'flex' }}>
      <PdfViewer src={pdfBytes({ pages: [{ text: 'Older browser' }] })} />
    </div>,
  );
  await expect
    .poll(() => document.querySelector('.textLayer')?.textContent, { timeout: 15_000 })
    .toContain('Older browser');
  expect(typeof statics.withResolvers).toBe('function');
  expect(workerTraffic.urls).toHaveLength(1);
  expect(workerTraffic.urls[0]).toMatch(/^blob:/);
});

test('the polyfilled worker wrapper installs Promise.withResolvers in a worker that lacks it, then loads the worker', async () => {
  const { polyfilledWorkerUrl } = await import('../src/promiseWithResolvers');
  const probe = URL.createObjectURL(
    new Blob(
      [
        'const { promise, resolve } = Promise.withResolvers(); resolve("resolved");',
        'postMessage(await promise);',
      ],
      { type: 'text/javascript' },
    ),
  );
  const withoutNative = URL.createObjectURL(
    new Blob([`delete Promise.withResolvers; await import(${JSON.stringify(polyfilledWorkerUrl(probe))});`], {
      type: 'text/javascript',
    }),
  );
  const worker = new Worker(withoutNative, { type: 'module' });
  const answer = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message));
  });
  worker.terminate();
  expect(answer).toBe('resolved');
});
