import type { Entry, FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { AudioViewer, HtmlViewer, ImageViewer, VideoViewer } from '../src/renderers';
import AudioRenderer from '../src/renderers/media/AudioViewer';
import ImageRenderer from '../src/renderers/image/ImageViewer';
import { FileViewer } from '../src/viewer/FileViewer';
import {
  audioRenderer,
  htmlRenderer,
  imageRenderer,
  lightRenderers,
  textRenderer,
  videoRenderer,
} from '../src/viewer/lightRenderers';
import { resolveRenderer, type RendererProps, type ViewerError } from '../src/viewer/registry';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

const fileEntry = (path: string): Entry => ({ path, name: path.split('/').at(-1)!, kind: 'file' });

const part = <T extends Element = HTMLElement>(name: string): T =>
  document.querySelector<T>(`[data-fs-part=${name}]`)!;
const surface = (): HTMLElement => part('image-surface');
const stage = (): HTMLElement => part('image-stage');
const shownImage = (): HTMLImageElement => part<HTMLImageElement>('image-content');
const zoomLevel = (): string | null => part('image-zoom-level').textContent;

async function pngBlob(width: number, height: number, color: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
}

function wavBytes(seconds: number): Uint8Array<ArrayBuffer> {
  const sampleRate = 8000;
  const samples = seconds * sampleRate;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}

const wavUrl = (seconds = 2): string =>
  URL.createObjectURL(new Blob([wavBytes(seconds)], { type: 'audio/wav' }));
const garbageUrl = (): string =>
  URL.createObjectURL(new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' }));

const rendererProps = (entry: Entry, url: string, version = 1): RendererProps => ({
  entry,
  source: { kind: 'url', url, withCredentials: false },
  version,
  mode: undefined,
  isActive: true,
  readOnly: true,
  onError: () => {},
});

function sized(children: ReactNode, width = 200, height = 200): React.JSX.Element {
  return <div style={{ width, height, display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

async function mountImage(width = 400, height = 300): Promise<{ url: string }> {
  const url = URL.createObjectURL(await pngBlob(width, height, 'red'));
  await render(sized(<ImageRenderer {...rendererProps(fileEntry('photo.png'), url)} />));
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  await expect.poll(() => stage().getBoundingClientRect().width).toBeGreaterThan(0);
  return { url };
}

const fitScale = (width: number, height: number): number =>
  Math.min(1, surface().clientWidth / width, surface().clientHeight / height);

const pointUnder = (clientX: number, clientY: number): { u: number; v: number } => {
  const rect = stage().getBoundingClientRect();
  return { u: (clientX - rect.left) / rect.width, v: (clientY - rect.top) / rect.height };
};

const mediaElement = (): HTMLMediaElement => document.querySelector<HTMLMediaElement>('audio, video')!;
const STARTING_THE_MEDIA_PIPELINE = { timeout: 5000 };
const loadedMetadata = async (media: HTMLMediaElement, url: string): Promise<void> => {
  await expect
    .poll(
      () => media.src === url && media.readyState >= HTMLMediaElement.HAVE_METADATA,
      STARTING_THE_MEDIA_PIPELINE,
    )
    .toBe(true);
};

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

test('images, audio, video and HTML resolve to their renderers with the planned inputs and size caps', () => {
  const resolvedId = (path: string): string | undefined =>
    resolveRenderer(fileEntry(path), lightRenderers)?.id;
  expect(['a.png', 'b.SVG', 'c.webp'].map(resolvedId)).toEqual(Array(3).fill(imageRenderer.id));
  expect(['a.mp3', 'b.wav'].map(resolvedId)).toEqual([audioRenderer.id, audioRenderer.id]);
  expect(['a.mp4', 'b.webm'].map(resolvedId)).toEqual([videoRenderer.id, videoRenderer.id]);
  expect(['a.html', 'b.htm'].map(resolvedId)).toEqual([htmlRenderer.id, htmlRenderer.id]);
  expect(resolvedId('notes.txt')).toBe(textRenderer.id);
  expect(imageRenderer).toMatchObject({ input: 'url', maxBytes: 100 * MIB });
  expect(audioRenderer).toMatchObject({ input: 'url', maxBytes: 200 * MIB });
  expect(videoRenderer).toMatchObject({ input: 'url', maxBytes: 200 * MIB });
  expect(htmlRenderer).toMatchObject({ input: 'text', maxBytes: 5 * MIB, editable: true });
  expect(htmlRenderer.modes?.map((mode) => mode.value)).toEqual(['preview', 'source']);
});

test('plain wheel scrolls; Ctrl/⌘-wheel zooms at the cursor', async () => {
  const url = URL.createObjectURL(await pngBlob(400, 300, 'red'));
  await render(
    <div data-testid="page" style={{ height: 150, overflow: 'auto' }}>
      {sized(<ImageRenderer {...rendererProps(fileEntry('photo.png'), url)} />, 200, 200)}
      <div style={{ height: 600 }} />
    </div>,
  );
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  const page = document.querySelector<HTMLElement>('[data-testid=page]')!;
  const fit = fitScale(400, 300);
  await expect.poll(() => stage().getBoundingClientRect().width).toBeCloseTo(400 * fit, 0);

  await commands.mouse('[data-fs-part=image-surface]', [{ x: 60, y: 40 }, { wheel: 100 }]);
  await expect.poll(() => page.scrollTop).toBeGreaterThan(0);
  expect(stage().getBoundingClientRect().width).toBeCloseTo(400 * fit, 0);
  expect(surface().hasAttribute('data-zoomed')).toBe(false);
  page.scrollTop = 0;

  for (const holding of ['Control', 'Meta'] as const) {
    const before = stage().getBoundingClientRect().width;
    const box = surface().getBoundingClientRect();
    const cursor = { x: box.left + 60, y: box.top + 40 };
    const anchored = pointUnder(cursor.x, cursor.y);
    await commands.mouse('[data-fs-part=image-surface]', [
      { x: 60, y: 40 },
      { wheel: -100, holding },
    ]);
    await expect.poll(() => stage().getBoundingClientRect().width).toBeGreaterThan(before);
    const after = pointUnder(cursor.x, cursor.y);
    expect(after.u, holding).toBeCloseTo(anchored.u, 2);
    expect(after.v, holding).toBeCloseTo(anchored.v, 2);
    expect(page.scrollTop, holding).toBe(0);
  }
  expect(surface().hasAttribute('data-zoomed')).toBe(true);
});

test('drag pans with pointer capture; pointercancel or a lost capture ends the drag', async () => {
  await mountImage();
  surface().focus();
  await userEvent.keyboard('+++');
  await expect.poll(() => surface().hasAttribute('data-zoomed')).toBe(true);
  const pointerIds: number[] = [];
  surface().addEventListener('pointerdown', (event) => pointerIds.push(event.pointerId));
  surface().scrollLeft = 100;
  surface().scrollTop = 100;

  await commands.mouse('[data-fs-part=image-surface]', [{ x: 100, y: 100 }, 'down', { x: 60, y: 70 }]);
  const pointerId = pointerIds.at(-1)!;
  expect(surface().hasPointerCapture(pointerId)).toBe(true);
  expect(surface().hasAttribute('data-dragging')).toBe(true);
  await expect.poll(() => [surface().scrollLeft, surface().scrollTop]).toEqual([140, 130]);
  await commands.mouse('[data-fs-part=image-surface]', ['up']);
  expect(surface().hasPointerCapture(pointerId)).toBe(false);
  expect(surface().hasAttribute('data-dragging')).toBe(false);

  await commands.mouse('[data-fs-part=image-surface]', [{ x: 100, y: 100 }, 'down', { x: 90, y: 100 }]);
  await expect.poll(() => surface().scrollLeft).toBe(150);
  surface().dispatchEvent(
    new PointerEvent('pointercancel', { pointerId: pointerIds.at(-1)!, bubbles: true }),
  );
  await expect.poll(() => surface().hasAttribute('data-dragging')).toBe(false);
  expect(surface().hasPointerCapture(pointerIds.at(-1)!)).toBe(false);
  await commands.mouse('[data-fs-part=image-surface]', [{ x: 40, y: 100 }, 'up']);
  expect(surface().scrollLeft).toBe(150);

  await commands.mouse('[data-fs-part=image-surface]', [{ x: 100, y: 100 }, 'down', { x: 90, y: 100 }]);
  await expect.poll(() => surface().scrollLeft).toBe(160);
  expect(surface().hasPointerCapture(pointerIds.at(-1)!)).toBe(true);
  surface().releasePointerCapture(pointerIds.at(-1)!);
  await commands.mouse('[data-fs-part=image-surface]', [{ x: 40, y: 100 }]);
  await expect.poll(() => surface().hasAttribute('data-dragging')).toBe(false);
  expect(surface().scrollLeft).toBe(160);
  await commands.mouse('[data-fs-part=image-surface]', ['up']);
  expect(surface().scrollLeft).toBe(160);
});

test('zoom is announced once, after the gesture settles', async () => {
  await mountImage();
  const status = part('image-zoom-status');
  expect(status.getAttribute('role')).toBe('status');
  expect(part('image-zoom-level').hasAttribute('aria-live')).toBe(false);
  expect(part('image-zoom-level').tagName).toBe('SPAN');
  const announcements: string[] = [];
  new MutationObserver(() => announcements.push(status.textContent!)).observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  const box = surface().getBoundingClientRect();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (let tick = 0; tick < 4; tick++) {
      const before = zoomLevel();
      surface().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -60,
          ctrlKey: true,
          clientX: box.left + 50,
          clientY: box.top + 50,
          bubbles: true,
          cancelable: true,
        }),
      );
      await expect.poll(zoomLevel).not.toBe(before);
      vi.advanceTimersByTime(200);
    }
    expect(announcements).toEqual([]);
    vi.advanceTimersByTime(99);
    expect(announcements).toEqual([]);
    vi.advanceTimersByTime(1);
    await expect.poll(() => announcements).toEqual([`Zoom ${zoomLevel()}`]);
  } finally {
    vi.useRealTimers();
  }
});

test('zooming out from a fit below 0.1 never zooms in; = zooms in', async () => {
  await mountImage(4000, 3000);
  const fit = fitScale(4000, 3000);
  expect(fit).toBeLessThan(0.1);
  const fitted = Math.round(4000 * fit);
  expect(stage().offsetWidth).toBe(fitted);
  surface().focus();
  await userEvent.keyboard('-');
  const box = surface().getBoundingClientRect();
  surface().dispatchEvent(
    new WheelEvent('wheel', {
      deltaY: 200,
      ctrlKey: true,
      clientX: box.left + 50,
      clientY: box.top + 50,
      bubbles: true,
      cancelable: true,
    }),
  );
  await userEvent.click(part('image-button'));
  expect(stage().offsetWidth).toBe(fitted);
  surface().focus();
  await userEvent.keyboard('=');
  await expect.poll(() => stage().offsetWidth).toBe(1000);
});

test('a Safari pinch gesture zooms at the gesture point', async () => {
  await mountImage();
  const box = surface().getBoundingClientRect();
  const at = { clientX: box.left + 60, clientY: box.top + 40 };
  const anchored = pointUnder(at.clientX, at.clientY);
  const before = stage().getBoundingClientRect().width;
  const gesture = (type: string, scale: number): boolean =>
    surface().dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { scale, ...at }));
  expect(gesture('gesturestart', 1)).toBe(false);
  expect(gesture('gesturechange', 1.5)).toBe(false);
  await expect.poll(() => stage().getBoundingClientRect().width).toBeCloseTo(before * 1.5, 0);
  const after = pointUnder(at.clientX, at.clientY);
  expect(after.u).toBeCloseTo(anchored.u, 2);
  expect(after.v).toBeCloseTo(anchored.v, 2);
});

test('full screen is offered only where enabled, is a toggle button, and leaves focus on the image', async () => {
  await mountImage();
  const fullscreenButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Full screen',
  );
  expect(fullscreenButton !== undefined).toBe(document.fullscreenEnabled);
  if (!fullscreenButton) return;
  expect(fullscreenButton.getAttribute('aria-pressed')).toBe('false');
  await userEvent.click(fullscreenButton);
  await expect.poll(() => document.activeElement).toBe(surface());
  await expect
    .poll(() => fullscreenButton.getAttribute('aria-pressed'))
    .toBe(String(document.fullscreenElement === surface()));
  if (document.fullscreenElement) await document.exitFullscreen();
});

test('the first painted frame already shows the image fitted', async () => {
  const url = URL.createObjectURL(await pngBlob(400, 300, 'red'));
  const widthsBeforeFirstPaint: number[] = [];
  const observer = new MutationObserver(() => {
    const shownStage = document.querySelector<HTMLElement>('[data-fs-part=image-stage]');
    if (!shownStage) return;
    observer.disconnect();
    requestAnimationFrame(() => widthsBeforeFirstPaint.push(shownStage.offsetWidth));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  await render(sized(<ImageRenderer {...rendererProps(fileEntry('photo.png'), url)} />));
  await expect.poll(() => widthsBeforeFirstPaint).toHaveLength(1);
  expect(widthsBeforeFirstPaint[0]).toBe(Math.round(400 * fitScale(400, 300)));
});

test('keys + - 0 r and arrow panning when zoomed', async () => {
  await mountImage();
  const fit = fitScale(400, 300);
  const stageSize = (): number[] => [stage().offsetWidth, stage().offsetHeight];
  expect(stageSize()).toEqual([Math.round(400 * fit), Math.round(300 * fit)]);
  surface().focus();

  await userEvent.keyboard('+');
  const zoomedIn = (Math.floor(fit / 0.25) + 1) * 0.25;
  await expect.poll(stageSize).toEqual([400 * zoomedIn, 300 * zoomedIn]);
  expect(zoomLevel()).toBe(`${Math.round(zoomedIn * 100)}%`);
  await userEvent.keyboard('-');
  await expect.poll(stageSize).toEqual([400 * (zoomedIn - 0.25), 300 * (zoomedIn - 0.25)]);
  await userEvent.keyboard('0');
  await expect.poll(stageSize).toEqual([Math.round(400 * fit), Math.round(300 * fit)]);

  await userEvent.keyboard('r');
  await expect.poll(() => shownImage().style.transform).toContain('rotate(90deg)');
  const rotatedFit = fitScale(300, 400);
  expect(stageSize()).toEqual([Math.round(300 * rotatedFit), Math.round(400 * rotatedFit)]);
  await userEvent.keyboard('rrr');
  await expect.poll(() => shownImage().style.transform).toContain('rotate(0deg)');

  surface().scrollLeft = 0;
  await userEvent.keyboard('{ArrowRight}');
  expect(surface().scrollLeft).toBe(0);
  await userEvent.keyboard('++++');
  await expect.poll(() => surface().hasAttribute('data-zoomed')).toBe(true);
  surface().scrollLeft = 0;
  surface().scrollTop = 0;
  await userEvent.keyboard('{ArrowRight}{ArrowDown}');
  await expect.poll(() => [surface().scrollLeft, surface().scrollTop]).toEqual([40, 40]);
  await userEvent.keyboard('{ArrowLeft}');
  await expect.poll(() => surface().scrollLeft).toBe(0);
});

test('double-click toggles between fit and 2× at the cursor', async () => {
  await mountImage();
  const fit = fitScale(400, 300);
  await userEvent.dblClick(surface());
  await expect.poll(() => stage().offsetWidth).toBe(800);
  expect(zoomLevel()).toBe('200%');
  await userEvent.dblClick(surface());
  await expect.poll(() => stage().offsetWidth).toBe(Math.round(400 * fit));
});

test('a new version swaps the image without a blank frame and keeps zoom', async () => {
  const first = URL.createObjectURL(await pngBlob(400, 300, 'red'));
  const entry = fileEntry('photo.png');
  const screen = await render(sized(<ImageRenderer {...rendererProps(entry, first)} />));
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  surface().focus();
  await userEvent.keyboard('+++r');
  await expect.poll(() => shownImage().style.transform).toContain('rotate(90deg)');
  const zoom = zoomLevel();
  const element = shownImage();

  const heldDecodes: Array<() => void> = [];
  const decode = HTMLImageElement.prototype.decode;
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    return new Promise<void>((resolve, reject) => {
      heldDecodes.push(() => void decode.call(this).then(resolve, reject));
    });
  });
  const shownWhenSwapped: Array<{ src: string; complete: boolean; width: number }> = [];
  new MutationObserver(() =>
    shownWhenSwapped.push({ src: element.src, complete: element.complete, width: element.naturalWidth }),
  ).observe(element, { attributes: true, attributeFilter: ['src'] });

  const second = URL.createObjectURL(await pngBlob(200, 100, 'blue'));
  await screen.rerender(sized(<ImageRenderer {...rendererProps(entry, second, 2)} />));
  await expect.poll(() => heldDecodes.length).toBe(1);
  expect(shownImage().src).toBe(first);
  expect(shownImage().complete).toBe(true);
  heldDecodes[0]!();

  await expect.poll(() => shownImage().src).toBe(second);
  expect(shownImage()).toBe(element);
  expect(shownWhenSwapped).toEqual([{ src: second, complete: true, width: 200 }]);
  expect(zoomLevel()).toBe(zoom);
  expect(shownImage().style.transform).toContain('rotate(90deg)');
  expect(shownImage().getAttribute('alt')).toBe('photo.png');
  expect(shownImage().getAttribute('decoding')).toBe('async');
});

interface HeldDecode {
  decoder: HTMLImageElement;
  release: () => Promise<void>;
}

function holdingDecodes(): HeldDecode[] {
  const held: HeldDecode[] = [];
  const decode = HTMLImageElement.prototype.decode;
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    return new Promise<void>((resolve, reject) => {
      held.push({
        decoder: this,
        release: async () => {
          try {
            await decode.call(this);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  });
  return held;
}

test('a version replaced before it decodes is cancelled; unmounting mid-decode reports nothing', async () => {
  const entry = fileEntry('photo.png');
  const errors: ViewerError[] = [];
  const at = async (url: string, version: number): Promise<React.JSX.Element> =>
    sized(<ImageRenderer {...rendererProps(entry, url, version)} onError={(error) => errors.push(error)} />);
  const [first, second, third, fourth] = await Promise.all(
    ['red', 'green', 'blue', 'black'].map(async (color) => URL.createObjectURL(await pngBlob(40, 30, color))),
  );
  const screen = await render(await at(first!, 1));
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  const held = holdingDecodes();

  await screen.rerender(await at(second!, 2));
  await expect.poll(() => held.length).toBe(1);
  await screen.rerender(await at(third!, 3));
  await expect.poll(() => held.length).toBe(2);
  expect(held[0]!.decoder.getAttribute('src')).toBe('');
  await held[0]!.release();
  expect(shownImage().src).toBe(first);
  await held[1]!.release();
  await expect.poll(() => shownImage().src).toBe(third);

  await screen.rerender(await at(fourth!, 4));
  await expect.poll(() => held.length).toBe(3);
  await screen.unmount();
  expect(held[2]!.decoder.getAttribute('src')).toBe('');
  await held[2]!.release();
  expect(errors).toEqual([]);
});

test('a refresh that cannot be decoded keeps the image on screen, reports load_error and, standalone, says it is the previous version', async () => {
  const entry = fileEntry('photo.png');
  const errors: ViewerError[] = [];
  const first = URL.createObjectURL(await pngBlob(40, 30, 'red'));
  const broken = URL.createObjectURL(new Blob([new Uint8Array(64).fill(3)], { type: 'image/png' }));
  const report = (error: ViewerError): number => errors.push(error);
  const screen = await render(sized(<ImageRenderer {...rendererProps(entry, first)} onError={report} />));
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  await screen.rerender(sized(<ImageRenderer {...rendererProps(entry, broken, 2)} onError={report} />));
  await expect.poll(() => errors.map((error) => error.kind)).toEqual(['load_error']);
  expect(shownImage().src).toBe(first);
  await screen.unmount();

  const standaloneErrors: ViewerError[] = [];
  const reportStandalone = (error: ViewerError): number => standaloneErrors.push(error);
  const red = await pngBlob(40, 30, 'red');
  const standalone = await render(<ImageViewer src={red} fileName="a.png" onError={reportStandalone} />);
  await expect.poll(() => document.querySelector('[data-fs-part=image-content]')).not.toBeNull();
  const shown = shownImage().src;
  const garbage = new Blob([new Uint8Array(64).fill(3)], { type: 'image/png' });
  await standalone.rerender(<ImageViewer src={garbage} fileName="a.png" onError={reportStandalone} />);
  await expect.poll(() => standaloneErrors.map((error) => error.kind)).toEqual(['load_error']);
  expect(shownImage().src).toBe(shown);
  expect([...document.querySelectorAll('[role=alert]')].map((alert) => alert.textContent)).toEqual([
    "The latest version of this file couldn't be opened, so this is the previous version. This file couldn't be opened. Try again, or download it.",
  ]);
  expect(part('viewer-stale-notice')).not.toBeNull();
});

test('video plays from adapter.url without reading the file', async () => {
  const memory = createMemoryAdapter({ files: { 'clip.webm': new Uint8Array(16) } });
  const url = wavUrl();
  const adapter: FileSystemAdapter = { ...memory, url: () => url };
  const read = vi.spyOn(adapter, 'read');
  await render(
    <FileSystemProvider adapter={adapter}>
      <FileViewer path="clip.webm" renderers={lightRenderers} />
    </FileSystemProvider>,
  );
  await expect.poll(() => document.querySelector('video')).not.toBeNull();
  const video = document.querySelector('video')!;
  await loadedMetadata(video, url);
  expect(video.controls).toBe(true);
  expect(video.preload).toBe('metadata');
  expect(video.crossOrigin).toBeNull();
  video.muted = true;
  await video.play();
  await expect.poll(() => video.currentTime, STARTING_THE_MEDIA_PIPELINE).toBeGreaterThan(0);
  expect(read).not.toHaveBeenCalled();
});

test('a url with credentials sets crossOrigin on media and images', async () => {
  const url = wavUrl();
  const credentialed = { kind: 'url', url, withCredentials: true } as const;
  const screen = await render(
    <AudioRenderer {...rendererProps(fileEntry('a.wav'), url)} source={credentialed} />,
  );
  await expect.poll(() => mediaElement()?.crossOrigin).toBe('use-credentials');
  await screen.unmount();
  const image = URL.createObjectURL(await pngBlob(10, 10, 'red'));
  await render(
    <ImageRenderer {...rendererProps(fileEntry('a.png'), image)} source={{ ...credentialed, url: image }} />,
  );
  await expect.poll(() => document.querySelector('img')?.crossOrigin).toBe('use-credentials');
});

function refusingPlayback(): { calls: () => number; rejectionHandled: () => boolean; restore: () => void } {
  const realPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')!;
  let calls = 0;
  let rejectionHandled = false;
  HTMLMediaElement.prototype.play = function play(): Promise<void> {
    calls++;
    const refused = Promise.reject(new DOMException('autoplay refused', 'NotAllowedError'));
    const then = refused.then.bind(refused);
    return Object.assign(refused, {
      then: (onFulfilled?: () => unknown, onRejected?: (reason: unknown) => unknown) => {
        if (onRejected) rejectionHandled = true;
        return then(onFulfilled, onRejected);
      },
    });
  };
  return {
    calls: () => calls,
    rejectionHandled: () => rejectionHandled,
    restore: () => Object.defineProperty(HTMLMediaElement.prototype, 'play', realPlay),
  };
}

test('media pauses when the tab is inactive; play() rejection is caught', async () => {
  const entry = fileEntry('song.wav');
  const first = wavUrl();
  const screen = await render(<AudioRenderer {...rendererProps(entry, first)} />);
  await expect.poll(() => mediaElement()).not.toBeNull();
  const audio = mediaElement();
  await loadedMetadata(audio, first);
  audio.muted = true;
  await audio.play();
  expect(audio.paused).toBe(false);

  await screen.rerender(<AudioRenderer {...rendererProps(entry, first)} isActive={false} />);
  await expect.poll(() => audio.paused).toBe(true);

  await screen.rerender(<AudioRenderer {...rendererProps(entry, first)} />);
  await audio.play();
  const playback = refusingPlayback();
  try {
    const second = wavUrl();
    await screen.rerender(<AudioRenderer {...rendererProps(entry, second, 2)} />);
    await expect.poll(playback.calls).toBe(1);
    expect(playback.rejectionHandled()).toBe(true);
  } finally {
    playback.restore();
  }
});

test('a refresh keeps currentTime', async () => {
  const entry = fileEntry('song.wav');
  const first = wavUrl();
  const screen = await render(<AudioRenderer {...rendererProps(entry, first)} />);
  await expect.poll(() => mediaElement()).not.toBeNull();
  const audio = mediaElement();
  await loadedMetadata(audio, first);
  audio.currentTime = 1.25;
  await expect.poll(() => audio.seeking).toBe(false);

  const second = wavUrl();
  await screen.rerender(<AudioRenderer {...rendererProps(entry, second, 2)} />);
  await loadedMetadata(audio, second);
  await expect.poll(() => audio.currentTime).toBeCloseTo(1.25, 1);
  expect(audio.paused).toBe(true);
  expect(mediaElement()).toBe(audio);
});

test('unplayable media shows unsupported_media', async () => {
  const errors: ViewerError[] = [];
  const screen = await render(
    <AudioRenderer
      {...rendererProps(fileEntry('bad.wav'), garbageUrl())}
      onError={(error) => errors.push(error)}
    />,
  );
  await expect.poll(() => errors.map((error) => error.kind)).toEqual(['unsupported_media']);
  await screen.unmount();

  const memory = createMemoryAdapter({ files: { 'bad.mp4': new Uint8Array(4096).fill(7) } });
  await render(
    <FileSystemProvider adapter={memory}>
      <FileViewer path="bad.mp4" renderers={lightRenderers} />
    </FileSystemProvider>,
  );
  await expect
    .poll(() => document.querySelector('[role=alert]')?.textContent)
    .toContain("Your browser can't play this format.");
});

test('HTML preview is sandboxed without allow-same-origin and titled with the file name; source mode shows text', async () => {
  const html = '<h1>Hello</h1><script>parent.document.title = "escaped"</script>';
  const memory = createMemoryAdapter({ files: { 'site/page.html': html, 'empty.html': '' } });
  const screen = await render(
    <FileSystemProvider adapter={memory}>
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path="site/page.html" renderers={lightRenderers} />
      </div>
    </FileSystemProvider>,
  );
  await expect.poll(() => document.querySelector('iframe')).not.toBeNull();
  const iframe = document.querySelector('iframe')!;
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  expect(iframe.sandbox.contains('allow-same-origin')).toBe(false);
  expect(iframe.title).toBe('Preview of page.html');
  expect(iframe.getAttribute('srcdoc')).toMatch(
    /^<meta http-equiv="Content-Security-Policy" content="[^"]+">/,
  );
  expect(iframe.getAttribute('srcdoc')!.endsWith(html)).toBe(true);
  expect(part('viewer').getAttribute('data-mode')).toBe('preview');

  await userEvent.click(document.querySelector<HTMLElement>('[data-fs-part=viewer-mode]:nth-child(2)')!);
  await expect.poll(() => document.querySelector('textarea')?.value).toBe(html);
  expect(document.querySelector('iframe')).toBeNull();
  await screen.unmount();

  await render(
    <FileSystemProvider adapter={memory}>
      <FileViewer path="empty.html" renderers={lightRenderers} />
    </FileSystemProvider>,
  );
  await expect
    .poll(() => document.querySelector('[data-fs-part=html-empty]')?.textContent)
    .toBe('No content to preview');
  expect(document.querySelector('iframe')).toBeNull();
});

test('the HTML preview cannot fetch: its Content-Security-Policy refuses connections', async () => {
  const fromThePreview: unknown[] = [];
  const listener = (event: MessageEvent): void => {
    if (event.source === document.querySelector('iframe')?.contentWindow) fromThePreview.push(event.data);
  };
  window.addEventListener('message', listener);
  onTestFinished(() => window.removeEventListener('message', listener));
  const page = `<script>
    document.addEventListener('securitypolicyviolation', (event) =>
      parent.postMessage('refused ' + event.effectiveDirective, '*'));
    fetch('${location.origin}/never').then(() => parent.postMessage('fetched', '*'), () => undefined);
  </script>`;
  await render(<HtmlViewer src={new Blob([page])} fileName="page.html" />);
  await expect.poll(() => fromThePreview).toContain('refused connect-src');
  expect(fromThePreview).not.toContain('fetched');
});

test('standalone HtmlViewer previews bytes and shows source in source mode', async () => {
  const screen = await render(<HtmlViewer src={new Blob(['<p>hi</p>'])} fileName="a.html" />);
  await expect.poll(() => document.querySelector('iframe')?.getAttribute('srcdoc')).toMatch(/<p>hi<\/p>$/);
  expect(document.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
  expect(document.querySelector('iframe')!.title).toBe('Preview of a.html');
  await screen.rerender(<HtmlViewer src={new Blob(['<p>hi</p>'])} fileName="a.html" mode="source" />);
  await expect.poll(() => document.querySelector('textarea')?.value).toBe('<p>hi</p>');
});

test('standalone media: bytes become object URLs revoked on change and unmount; SVG a data: URL; unsafe URLs are refused', async () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = createObjectURL(blob);
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));

  const first = await pngBlob(20, 10, 'red');
  const screen = await render(<ImageViewer src={first} fileName="a.png" />);
  await expect.poll(() => document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
  expect(created).toHaveLength(1);
  await screen.rerender(<ImageViewer src={new Uint8Array(await first.arrayBuffer())} fileName="a.png" />);
  await expect.poll(() => created).toHaveLength(2);
  await expect.poll(() => document.querySelector('img')?.getAttribute('src')).toBe(created[1]);
  expect(revoked).toEqual([created[0]]);
  await screen.unmount();
  expect(revoked).toEqual(created);

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  const svgScreen = await render(<ImageViewer src={new TextEncoder().encode(svg)} fileName="logo.svg" />);
  await expect
    .poll(() => document.querySelector('img')?.getAttribute('src'))
    .toMatch(/^data:image\/svg\+xml;base64,/);
  await svgScreen.unmount();

  const errors: ViewerError[] = [];
  await render(
    <VideoViewer src="javascript:alert(1)" fileName="x.mp4" onError={(error) => errors.push(error)} />,
  );
  await expect.poll(() => errors.map((error) => error.kind)).toEqual(['load_error']);
  expect(document.querySelector('video')).toBeNull();
  expect(document.querySelector('[role=alert]')?.textContent).toBe(
    "This file couldn't be opened. Try again, or download it.",
  );
});

test('standalone media bytes: the old object URL is revoked only once the new one is on the element', async () => {
  const revocations: Array<{ url: string; elementSrc: string | undefined }> = [];
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revocations.push({ url, elementSrc: document.querySelector('audio')?.getAttribute('src') ?? undefined });
    revokeObjectURL(url);
  });
  const screen = await render(<AudioViewer src={wavBytes(1)} fileName="tone.wav" />);
  await expect.poll(() => document.querySelector('audio')?.getAttribute('src')).toMatch(/^blob:/);
  const first = document.querySelector('audio')!.getAttribute('src')!;
  await screen.rerender(<AudioViewer src={wavBytes(1)} fileName="tone.wav" />);
  await expect.poll(() => revocations).toHaveLength(1);
  const second = document.querySelector('audio')!.getAttribute('src')!;
  expect(second).not.toBe(first);
  expect(revocations).toEqual([{ url: first, elementSrc: second }]);
});

test('standalone AudioViewer plays bytes and reports unplayable ones', async () => {
  const screen = await render(<AudioViewer src={wavBytes(1)} fileName="tone.wav" theme="dark" />);
  await expect.poll(() => mediaElement()?.readyState).toBeGreaterThanOrEqual(HTMLMediaElement.HAVE_METADATA);
  expect(part('media-viewer').getAttribute('data-theme')).toBe('dark');
  await screen.unmount();

  await render(<AudioViewer src={new Uint8Array(4096).fill(7)} fileName="bad.wav" />);
  await expect
    .poll(() => document.querySelector('[role=alert]')?.textContent)
    .toBe("Your browser can't play this format. Download it to open it in another app.");
});

test('axe: each renderer, light and dark', async () => {
  const image = await pngBlob(40, 30, 'red');
  const screen = await render(
    <div>
      {sized(<ImageViewer src={image} fileName="photo.png" />)}
      <AudioViewer src={wavBytes(1)} fileName="tone.wav" />
      <VideoViewer src={wavBytes(1)} fileName="clip.webm" />
      {sized(<HtmlViewer src={new Blob(['<p>hi</p>'])} fileName="page.html" />)}
    </div>,
  );
  await expect.poll(() => document.querySelector('img')).not.toBeNull();
  await expect.poll(() => document.querySelector('iframe')).not.toBeNull();
  await expect.poll(() => document.querySelector('audio')).not.toBeNull();
  await expect.poll(() => document.querySelector('video')).not.toBeNull();
  await expectNoAxeViolations(screen.container);
});

test('axe: error states, light and dark', async () => {
  const revokedUrl = URL.createObjectURL(new Blob(['<p>gone</p>']));
  URL.revokeObjectURL(revokedUrl);
  const screen = await render(
    <div>
      <ImageViewer src="javascript:void 0" fileName="photo.png" />
      <AudioViewer src={new Uint8Array(4096).fill(7)} fileName="bad.wav" />
      <HtmlViewer src={revokedUrl} fileName="page.html" />
    </div>,
  );
  await expect.poll(() => document.querySelectorAll('[role=alert]').length).toBe(3);
  await expectNoAxeViolations(screen.container);
});
