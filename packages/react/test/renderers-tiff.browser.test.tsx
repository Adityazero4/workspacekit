import type { Entry } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { StrictMode, type ReactNode } from 'react';
import UTIF from 'utif2';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { TiffViewer } from '../src/renderers';
import TiffRenderer from '../src/renderers/tiff/TiffViewer';
import { FileViewer } from '../src/viewer/FileViewer';
import { imageRenderer, lightRenderers, tiffRenderer } from '../src/viewer/lightRenderers';
import { resolveRenderer, type RendererProps, type ViewerError } from '../src/viewer/registry';
import { deflatedTiffBytes, rawTiff, tiffBytes, type TiffFixturePage } from './fixtures/tiff';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';

const MIB = 1024 * 1024;
const GAP = 16;
const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';
const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const STALE_NOTICE =
  "The latest version of this file couldn't be opened, so this is the previous version. This file couldn't be opened. Try again, or download it.";
const UNSUPPORTED_COMPRESSION_COPY =
  "This TIFF uses a compression this viewer doesn't support. Download it to open it.";

afterEach(() => {
  vi.restoreAllMocks();
});

const fileEntry = (path: string): Entry => ({ path, name: path.split('/').at(-1)!, kind: 'file' });

const part = <T extends Element = HTMLElement>(name: string): T =>
  document.querySelector<T>(`[data-fs-part=${name}]`)!;
const parts = <T extends Element = HTMLElement>(name: string): T[] => [
  ...document.querySelectorAll<T>(`[data-fs-part=${name}]`),
];
const viewport = (): HTMLElement => part('pages-viewport');
const pageImages = (): HTMLImageElement[] => parts<HTMLImageElement>('tiff-page-image');
const shownPageNumbers = (): number[] =>
  pageImages().map((image) => Number(/^Page (\d+)/.exec(image.alt)![1]) - 1);
const pageIndicator = (): string | null => part('tiff-page-indicator').textContent;
const zoomLevel = (): string | null => part('tiff-zoom-level').textContent;
const button = (name: string): HTMLButtonElement =>
  parts<HTMLButtonElement>('tiff-button').find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  )!;

const rendererProps = (data: ArrayBuffer, version = 1, name = 'scan.tiff'): RendererProps => ({
  entry: fileEntry(name),
  source: { kind: 'arrayBuffer', data },
  version,
  mode: undefined,
  isActive: true,
  readOnly: true,
  onError: () => {},
});

function sized(children: ReactNode, width = 600, height = 400): React.JSX.Element {
  return <div style={{ width, height, display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

function spyOnPageDecodes(): { widthsDecoded: number[] } {
  const widthsDecoded: number[] = [];
  const decodeImage = UTIF.decodeImage.bind(UTIF);
  vi.spyOn(UTIF, 'decodeImage').mockImplementation((buffer, ifd) => {
    widthsDecoded.push((ifd['t256'] as number[])[0]!);
    decodeImage(buffer, ifd);
  });
  return { widthsDecoded };
}

function spyOnObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = createObjectURL(blob);
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
    revokeObjectURL(url);
  });
  return { created, revoked };
}

const pagesOf = (count: number, page: (index: number) => Partial<TiffFixturePage> = () => ({})) =>
  Array.from({ length: count }, (_, index) => ({ width: 200, height: 300, ...page(index) }));

async function expectNoAxeViolations(element: Element): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await cssTransitionsToSettle();
    const results = await axe.run(element);
    expect(
      results.violations.map((violation) => `${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
  await commands.emulateMedia({ colorScheme: null });
}

test('TIFF resolves to the tiff renderer over the image renderer, reading an ArrayBuffer up to 200 MiB', () => {
  const resolvedId = (path: string): string | undefined =>
    resolveRenderer(fileEntry(path), lightRenderers)?.id;
  expect(['a.tif', 'b.TIFF'].map(resolvedId)).toEqual([tiffRenderer.id, tiffRenderer.id]);
  expect(resolveRenderer(fileEntry('a.tiff'), [imageRenderer, tiffRenderer])?.id).toBe(tiffRenderer.id);
  expect(tiffRenderer).toMatchObject({ input: 'arrayBuffer', maxBytes: 200 * MIB });
});

test('a 3-page TIFF shows pages with sizes from the tags before decoding', async () => {
  const sizes = [
    { width: 120, height: 80 },
    { width: 100, height: 150 },
    { width: 140, height: 60 },
  ];
  const heldBlobs: Array<() => void> = [];
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    ...args
  ) {
    heldBlobs.push(() => toBlob.apply(this, args));
  });
  await render(sized(<TiffRenderer {...rendererProps(tiffBytes(sizes))} />));
  await expect.poll(() => parts('pages-page').length).toBe(3);
  expect(parts('pages-page').map((page) => page.getBoundingClientRect().toJSON())).toMatchObject(sizes);
  expect(pageImages()).toEqual([]);

  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockRestore();
  for (const release of heldBlobs) release();
  await expect
    .poll(() => pageImages().filter((image) => image.complete && image.naturalWidth > 0))
    .toHaveLength(3);
  expect(
    pageImages().map(({ naturalWidth, naturalHeight }) => ({ width: naturalWidth, height: naturalHeight })),
  ).toEqual(sizes);
  expect(pageImages().map((image) => image.alt)).toEqual([
    'Page 1 of scan.tiff',
    'Page 2 of scan.tiff',
    'Page 3 of scan.tiff',
  ]);
});

test('only visible pages decode; LRU of 8 revokes evicted URLs', async () => {
  const { widthsDecoded } = spyOnPageDecodes();
  const { created, revoked } = spyOnObjectUrls();
  const pageCount = 30;
  const data = tiffBytes(pagesOf(pageCount, (index) => ({ width: 100 + index, height: 200 })));
  await render(sized(<TiffRenderer {...rendererProps(data)} />, 600, 300));
  const decodedIndices = (): number[] => widthsDecoded.map((width) => width - 100);
  await expect.poll(() => document.querySelector('[data-fs-part=pages-viewport]')).not.toBeNull();
  const showAround = async (index: number): Promise<void> => {
    viewport().scrollTop = GAP + index * (200 + GAP);
    await expect.poll(() => shownPageNumbers()).toContain(index);
    await expect.poll(() => pageImages().length).toBe(parts('pages-page').length);
  };

  await showAround(0);
  expect(new Set(decodedIndices())).toEqual(new Set(shownPageNumbers()));
  expect(decodedIndices().length).toBeLessThan(5);
  await showAround(8);
  const decodesBeforeReturning = decodedIndices().length;
  await showAround(0);
  expect(decodedIndices()).toHaveLength(decodesBeforeReturning);

  for (const index of [16, 24, 29]) await showAround(index);
  expect(new Set(decodedIndices()).size).toBe(decodedIndices().length);
  expect(decodedIndices().length).toBeGreaterThan(8);
  await expect.poll(() => created).toHaveLength(decodedIndices().length);
  await expect.poll(() => revoked).toHaveLength(created.length - 8);
  expect(created.filter((url) => !revoked.includes(url))).toEqual(
    expect.arrayContaining(pageImages().map((image) => image.src)),
  );
});

test('a page over 100 MP shows too_large without decoding', async () => {
  const { widthsDecoded } = spyOnPageDecodes();
  const data = tiffBytes([
    { width: 400, height: 300 },
    { width: 10_001, height: 10_000, claimsSizeWithoutPixels: true },
  ]);
  await render(sized(<TiffRenderer {...rendererProps(data)} />));
  await expect.poll(() => pageImages()).toHaveLength(1);
  await expect
    .poll(() => parts('tiff-page-message').map((message) => message.textContent))
    .toEqual([TOO_LARGE_COPY]);
  expect(widthsDecoded).toEqual([400]);
});

test('a new version keeps the current page and zoom', async () => {
  const { created, revoked } = spyOnObjectUrls();
  const pages = pagesOf(6);
  const screen = await render(sized(<TiffRenderer {...rendererProps(tiffBytes(pages), 1)} />));
  await expect.poll(() => pageImages().length).toBeGreaterThan(0);
  await userEvent.click(button('Zoom in'));
  await expect.poll(() => zoomLevel()).toBe('125%');
  viewport().focus();
  await userEvent.keyboard('{PageDown}{PageDown}');
  await expect.poll(() => pageIndicator()).toBe('Page 3 of 6');
  await expect.poll(() => shownPageNumbers()).toContain(2);
  const scrollTop = viewport().scrollTop;
  const firstVersionUrls = [...created];

  const blue = pages.map((page) => ({ ...page, rgb: [0, 0, 255] as const }));
  await screen.rerender(sized(<TiffRenderer {...rendererProps(tiffBytes(blue), 2)} />));
  await expect.poll(() => pageImages().every((image) => !firstVersionUrls.includes(image.src))).toBe(true);
  expect(shownPageNumbers()).toContain(2);
  expect(pageIndicator()).toBe('Page 3 of 6');
  expect(zoomLevel()).toBe('125%');
  expect(viewport().scrollTop).toBe(scrollTop);
  await expect.poll(() => firstVersionUrls.every((url) => revoked.includes(url))).toBe(true);
});

test('unmount revokes every object URL', async () => {
  const { created, revoked } = spyOnObjectUrls();
  const data = tiffBytes(pagesOf(12, () => ({ height: 120 })));
  const screen = await render(sized(<TiffRenderer {...rendererProps(data)} />));
  await expect.poll(() => pageImages().length).toBeGreaterThan(1);
  viewport().scrollTop = viewport().scrollHeight;
  await screen.unmount();
  await expect.poll(() => created.length).toBeGreaterThan(1);
  await expect.poll(() => created.filter((url) => !revoked.includes(url))).toEqual([]);
});

test('zoom buttons step by 0.25, fit fits the widest page to the width, and the page is announced', async () => {
  const pages = pagesOf(3, () => ({ width: 1136, height: 1200 }));
  await render(sized(<TiffRenderer {...rendererProps(tiffBytes(pages))} />));
  await expect.poll(() => zoomLevel()).toBe('50%');
  expect(parts('pages-page')[0]!.getBoundingClientRect().width).toBe(568);
  await userEvent.click(button('Zoom in'));
  await expect.poll(() => zoomLevel()).toBe('75%');
  await userEvent.click(button('Zoom out'));
  await userEvent.click(button('Zoom out'));
  await expect.poll(() => zoomLevel()).toBe('25%');
  await userEvent.click(button('Fit width'));
  await expect.poll(() => zoomLevel()).toBe('50%');
  expect(part('tiff-status').getAttribute('role')).toBe('status');
  expect(part('tiff-status').textContent).toBe('');
  viewport().focus();
  await userEvent.keyboard('{End}');
  await expect.poll(() => pageIndicator()).toBe('Page 3 of 3');
  await expect.poll(() => part('tiff-status').textContent).toBe('Page 3 of 3');
});

function malformedTiff(patch: (view: DataView, directoryAt: number) => void): ArrayBuffer {
  const data = tiffBytes([{ width: 4, height: 4 }]);
  const view = new DataView(data);
  patch(view, view.getUint32(4, true));
  return data;
}

test('a file that is not a TIFF, loops its directories or claims billions of values reports load_error', async () => {
  const directoriesLoop = malformedTiff((view, directoryAt) =>
    view.setUint32(directoryAt + 2 + view.getUint16(directoryAt, true) * 12, directoryAt, true),
  );
  const stripOffsetsEntry = 5;
  const billionsOfValues = malformedTiff((view, directoryAt) =>
    view.setUint32(directoryAt + 2 + stripOffsetsEntry * 12 + 4, 0xffff_ffff, true),
  );
  const notATiff = new TextEncoder().encode('not a tiff at all').buffer;
  const errors: ViewerError[] = [];
  const onError = (error: ViewerError): number => errors.push(error);
  await render(
    <div>
      {sized(<TiffRenderer {...rendererProps(notATiff)} onError={onError} />, 200, 100)}
      {sized(<TiffRenderer {...rendererProps(directoriesLoop)} onError={onError} />, 200, 100)}
      {sized(<TiffRenderer {...rendererProps(billionsOfValues)} onError={onError} />, 200, 100)}
    </div>,
  );
  await expect
    .poll(() => errors.map((error) => error.kind))
    .toEqual(['load_error', 'load_error', 'load_error']);
});

test('FileViewer reads a .tiff from the adapter as an ArrayBuffer and shows its pages', async () => {
  const adapter = createMemoryAdapter({
    files: { 'scans/fax.tif': new Uint8Array(tiffBytes(pagesOf(2, () => ({ width: 60, height: 40 })))) },
  });
  await render(
    sized(
      <FileSystemProvider adapter={adapter}>
        <FileViewer path="scans/fax.tif" renderers={lightRenderers} />
      </FileSystemProvider>,
    ),
  );
  await expect
    .poll(() => pageImages().map((image) => image.alt))
    .toEqual(['Page 1 of fax.tif', 'Page 2 of fax.tif']);
});

test('standalone TiffViewer shows bytes and reports a file that is not a TIFF', async () => {
  const screen = await render(
    sized(<TiffViewer src={new Uint8Array(tiffBytes(pagesOf(2)))} fileName="scan.tiff" theme="dark" />),
  );
  await expect.poll(() => pageImages()).toHaveLength(2);
  expect(part('tiff-viewer').getAttribute('data-theme')).toBe('dark');
  await screen.unmount();

  const errors: ViewerError[] = [];
  await render(
    sized(
      <TiffViewer src={new Blob(['nope'])} fileName="bad.tiff" onError={(error) => errors.push(error)} />,
    ),
  );
  await expect
    .poll(() => document.querySelector('[role=alert]')?.textContent)
    .toBe("This file couldn't be opened. Try again, or download it.");
  expect(errors.map((error) => error.kind)).toEqual(['load_error']);
});

async function pixelOf(image: HTMLImageElement): Promise<number[]> {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  return [...context.getImageData(image.naturalWidth - 1, image.naturalHeight - 1, 1, 1).data];
}

const pageMessages = (): Array<string | null> =>
  parts('tiff-page-message').map((message) => message.textContent);

test('LZW, PackBits and Deflate pages in several strips decode to their pixels', async () => {
  const page = { width: 30, height: 20, rgb: [10, 120, 230] as const };
  const sources = [
    tiffBytes([page], { compression: 'lzw', rowsPerStrip: 7 }),
    tiffBytes([page], { compression: 'packbits', rowsPerStrip: 7 }),
    await deflatedTiffBytes([page], { rowsPerStrip: 7 }),
  ];
  await render(
    <div>
      {sources.map((data, index) => (
        <div key={index} style={{ width: 200, height: 100, display: 'flex', flexDirection: 'column' }}>
          <TiffRenderer {...rendererProps(data)} />
        </div>
      ))}
    </div>,
  );
  await expect.poll(() => pageImages()).toHaveLength(3);
  for (const image of pageImages()) expect(await pixelOf(image)).toEqual([10, 120, 230, 255]);
});

test('a tiled page decodes its tiles into place, without console noise', async () => {
  const log = vi.spyOn(console, 'log');
  const tileBytes = 16 * 16 * 3;
  const [offsetsAt, countsAt, tilesAt] = [200, 208, 216];
  const data = rawTiff(tilesAt + 2 * tileBytes, [
    {
      at: 8,
      entries: [
        { tag: 256, type: 4, count: 1, value: 32 },
        { tag: 257, type: 4, count: 1, value: 16 },
        { tag: 258, type: 3, count: 1, shorts: [8] },
        { tag: 259, type: 3, count: 1, shorts: [1] },
        { tag: 262, type: 3, count: 1, shorts: [2] },
        { tag: 277, type: 3, count: 1, shorts: [3] },
        { tag: 322, type: 4, count: 1, value: 16 },
        { tag: 323, type: 4, count: 1, value: 16 },
        { tag: 324, type: 4, count: 2, value: offsetsAt },
        { tag: 325, type: 4, count: 2, value: countsAt },
      ],
    },
  ]);
  const view = new DataView(data);
  [tilesAt, tilesAt + tileBytes, tileBytes, tileBytes].forEach((value, index) =>
    view.setUint32(offsetsAt + index * 4, value, true),
  );
  const bytes = new Uint8Array(data);
  for (let pixel = 0; pixel < 256; pixel++) {
    bytes.set([255, 0, 0], tilesAt + pixel * 3);
    bytes.set([0, 0, 255], tilesAt + tileBytes + pixel * 3);
  }
  await render(sized(<TiffRenderer {...rendererProps(data)} />));
  await expect.poll(() => pageImages()).toHaveLength(1);
  expect(await pixelOf(pageImages()[0]!)).toEqual([0, 0, 255, 255]);
  expect(log).not.toHaveBeenCalled();
});

test('fast scrolling through Deflate pages decodes one page at a time and skips pages scrolled past', async () => {
  const { widthsDecoded } = spyOnPageDecodes();
  const heldBlobs: Array<() => void> = [];
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    ...args
  ) {
    heldBlobs.push(() => toBlob.apply(this, args));
  });
  const pageHeight = 200;
  const data = await deflatedTiffBytes(
    pagesOf(40, (index) => ({ width: 300 + index, height: pageHeight })),
    { rowsPerStrip: 50 },
  );
  await render(sized(<TiffRenderer {...rendererProps(data)} />, 600, 300));
  const isMounted = (index: number): boolean =>
    parts('pages-page').some(
      (page) => page.style.transform === `translateY(${GAP + index * (pageHeight + GAP)}px)`,
    );
  await expect.poll(() => heldBlobs).toHaveLength(1);
  for (const index of [10, 20, 30, 39]) {
    viewport().scrollTop = GAP + index * (pageHeight + GAP);
    await expect.poll(() => isMounted(index)).toBe(true);
  }
  const mountedAtTheEnd = parts('pages-page').length;
  for (let released = 0; released <= mountedAtTheEnd; released++) {
    await expect.poll(() => heldBlobs).toHaveLength(1);
    expect(widthsDecoded).toHaveLength(released + 1);
    heldBlobs.shift()!();
  }
  await expect.poll(() => pageImages().length).toBe(mountedAtTheEnd);
  const decodedPages = widthsDecoded.map((width) => width - 300);
  expect(decodedPages.slice(1)).toEqual(shownPageNumbers());
  expect(decodedPages[0]).toBe(0);
});

test('a Deflate bomb, an unsupported compression and 64-bit samples show page errors without reaching the decoder', async () => {
  const { widthsDecoded } = spyOnPageDecodes();
  const bomb = new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(8 * 2 ** 20)]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const stripAt = 300;
  const page = (compression: number, bitsPerSample: number, stripBytes: number) => [
    { tag: 256, type: 4, count: 1, value: 10 },
    { tag: 257, type: 4, count: 1, value: 10 },
    { tag: 258, type: 3, count: 1, shorts: [bitsPerSample] },
    { tag: 259, type: 3, count: 1, shorts: [compression] },
    { tag: 262, type: 3, count: 1, shorts: [2] },
    { tag: 273, type: 4, count: 1, value: stripAt },
    { tag: 277, type: 3, count: 1, shorts: [3] },
    { tag: 278, type: 4, count: 1, value: 10 },
    { tag: 279, type: 4, count: 1, value: stripBytes },
  ];
  const bombFile = rawTiff(stripAt + bomb.length, [
    { at: 8, entries: page(8, 8, bomb.length), next: 130 },
    { at: 130, entries: page(4, 8, 16), next: 252 },
    { at: 252, entries: page(1, 64, 16) },
  ]);
  new Uint8Array(bombFile).set(bomb, stripAt);
  await render(sized(<TiffRenderer {...rendererProps(bombFile)} />));
  await expect
    .poll(() => pageMessages())
    .toEqual([LOAD_ERROR_COPY, UNSUPPORTED_COMPRESSION_COPY, LOAD_ERROR_COPY]);
  expect(widthsDecoded).toEqual([]);
});

test('a page the browser cannot encode shows too_large', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null));
  await render(sized(<TiffRenderer {...rendererProps(tiffBytes(pagesOf(1)))} />));
  await expect.poll(() => pageMessages()).toEqual([TOO_LARGE_COPY]);
});

test('more than 8 small pages on screen are pinned: none is revoked while shown', async () => {
  const { revoked } = spyOnObjectUrls();
  await render(
    sized(<TiffRenderer {...rendererProps(tiffBytes(pagesOf(20, () => ({ width: 40, height: 10 }))))} />),
  );
  await expect.poll(() => pageImages().length).toBeGreaterThan(8);
  await expect.poll(() => pageImages().length).toBe(parts('pages-page').length);
  await expect
    .poll(() => pageImages().every((image) => image.complete && image.naturalWidth === 40))
    .toBe(true);
  expect(pageImages().filter((image) => revoked.includes(image.src))).toEqual([]);
});

test('under StrictMode each page decodes once and unmounting revokes every URL', async () => {
  const { widthsDecoded } = spyOnPageDecodes();
  const { created, revoked } = spyOnObjectUrls();
  const data = tiffBytes(pagesOf(3, (index) => ({ width: 100 + index, height: 60 })));
  const screen = await render(<StrictMode>{sized(<TiffRenderer {...rendererProps(data)} />)}</StrictMode>);
  await expect
    .poll(() => pageImages().filter((image) => image.complete && image.naturalWidth > 0))
    .toHaveLength(3);
  expect([...widthsDecoded].sort()).toEqual([100, 101, 102]);
  expect(created).toHaveLength(3);
  await screen.unmount();
  await expect.poll(() => created.filter((url) => !revoked.includes(url))).toEqual([]);
});

test('standalone: a new src that cannot be parsed keeps the pages, page and zoom, and reports the error', async () => {
  const errors: ViewerError[] = [];
  const onError = (error: ViewerError): number => errors.push(error);
  const viewer = (src: ArrayBuffer | Blob): React.JSX.Element =>
    sized(<TiffViewer src={src} fileName="scan.tiff" onError={onError} />);
  const screen = await render(viewer(tiffBytes(pagesOf(6))));
  await expect.poll(() => pageImages().length).toBeGreaterThan(0);
  await userEvent.click(button('Zoom in'));
  viewport().focus();
  await userEvent.keyboard('{PageDown}{PageDown}');
  await expect.poll(() => pageIndicator()).toBe('Page 3 of 6');
  await expect.poll(() => pageImages().length).toBe(parts('pages-page').length);
  const shown = pageImages().map((image) => image.src);
  await screen.rerender(viewer(new Blob(['not a tiff'])));
  await expect.poll(() => errors.map((error) => error.kind)).toEqual(['load_error']);
  expect(part('viewer-stale-notice').getAttribute('role')).toBe('alert');
  expect(part('viewer-stale-notice').textContent).toBe(STALE_NOTICE);
  await expectNoAxeViolations(screen.container);
  expect(pageImages().map((image) => image.src)).toEqual(shown);
  expect(pageIndicator()).toBe('Page 3 of 6');
  expect(zoomLevel()).toBe('125%');
  await screen.rerender(viewer(tiffBytes(pagesOf(6, () => ({ rgb: [0, 0, 255] })))));
  await expect.poll(() => document.querySelector('[data-fs-part=viewer-stale-notice]')).toBeNull();
});

test('zoom changes are announced once settled, and + = - 0 zoom from the pages', async () => {
  await render(sized(<TiffRenderer {...rendererProps(tiffBytes(pagesOf(2)))} />));
  await expect.poll(() => zoomLevel()).toBe('100%');
  expect(part('tiff-zoom-status').textContent).toBe('');
  viewport().focus();
  await userEvent.keyboard('+');
  await expect.poll(() => zoomLevel()).toBe('125%');
  await userEvent.keyboard('=');
  await expect.poll(() => zoomLevel()).toBe('150%');
  await expect.poll(() => part('tiff-zoom-status').textContent).toBe('Zoom 150%');
  await userEvent.keyboard('-');
  await expect.poll(() => zoomLevel()).toBe('125%');
  await userEvent.keyboard('0');
  await expect.poll(() => zoomLevel()).toBe('100%');
  await expect.poll(() => part('tiff-zoom-status').textContent).toBe('Zoom 100%');
});

test('axe: pages, a too-large page and an unreadable file, light and dark', async () => {
  const screen = await render(
    <div>
      {sized(
        <TiffViewer
          src={tiffBytes([
            { width: 200, height: 100 },
            { width: 10_001, height: 10_000, claimsSizeWithoutPixels: true },
          ])}
          fileName="scan.tiff"
        />,
      )}
      {sized(<TiffViewer src={new Blob(['nope'])} fileName="bad.tiff" />, 300, 100)}
    </div>,
  );
  await expect.poll(() => pageImages()).toHaveLength(1);
  await expect.poll(() => parts('tiff-page-message')).toHaveLength(1);
  await expect.poll(() => document.querySelectorAll('[role=alert]').length).toBe(1);
  await expectNoAxeViolations(screen.container);
});
