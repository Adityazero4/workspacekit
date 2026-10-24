import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { PPTX_MAX_BYTES, PptxViewer, type PptxViewerProps } from '../src';
import {
  imageBackground,
  picture,
  pptxBytes,
  shapeFilledWith,
  textShape,
  textSlides,
  type Relationship,
} from './fixtures/pptx';

const FIRST_DRAW_TIMEOUT_MS = 5000;
const PROBE_PATH = '/__pptx-probe__/';
const probe = (name: string): string => `${location.origin}${PROBE_PATH}${name}`;
const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';

afterEach(() => cleanup());

class BlobOverTheLimit extends Blob {
  override get size(): number {
    return PPTX_MAX_BYTES + 1;
  }
}

const sized = (node: ReactNode): ReactNode => (
  <div style={{ height: 480, width: 1100, display: 'flex', flexDirection: 'column' }}>{node}</div>
);

const slideHosts = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-fs-part=pptx-slide]'),
];
const firstSlide = (): ShadowRoot | null => slideHosts()[0]?.shadowRoot ?? null;
const indicator = (): string | null | undefined =>
  document.querySelector('[data-fs-part=pptx-slide-indicator]')?.textContent;

async function showDeck(bytes: Uint8Array, props: Partial<PptxViewerProps> = {}) {
  const screen = await render(sized(<PptxViewer src={bytes} fileName="deck.pptx" {...props} />));
  await expect.poll(() => firstSlide()?.textContent ?? '', { timeout: FIRST_DRAW_TIMEOUT_MS }).toMatch(/\S/);
  return screen;
}

const EXTERNAL_MEDIA: Relationship[] = [
  { id: 'rIdPicture', type: 'image', target: probe('picture.png'), external: true },
  { id: 'rIdFill', type: 'image', target: probe('fill.png'), external: true },
  { id: 'rIdBackground', type: 'image', target: probe('background.png'), external: true },
  { id: 'rIdPoster', type: 'image', target: probe('poster.png'), external: true },
  { id: 'rIdVideo', type: 'video', target: probe('video.mp4'), external: true },
];

const externalMediaDeck = (): Uint8Array =>
  pptxBytes({
    slides: [
      {
        background: imageBackground('<a:blip r:link="rIdBackground"/>'),
        shapes:
          textShape('External media') +
          picture('<a:blip r:link="rIdPicture"/>') +
          shapeFilledWith('<a:blip r:link="rIdFill"/>') +
          picture('<a:blip r:link="rIdPoster"/>', { nvPr: '<a:videoFile r:link="rIdVideo"/>' }),
        relationships: EXTERNAL_MEDIA,
      },
    ],
  });

const probeRequests = (): string[] =>
  performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes(PROBE_PATH));

function referencesIn(root: ShadowRoot): string[] {
  const elements = [...root.querySelectorAll('*')];
  return elements.flatMap((element) => [...element.attributes].map((attribute) => attribute.value));
}

test('external media is blocked by default: a picture, fill, background and video poster make no request', async () => {
  performance.clearResourceTimings();
  await showDeck(externalMediaDeck());
  expect(firstSlide()!.textContent).toContain('External media');
  expect(referencesIn(firstSlide()!).filter((value) => value.includes(PROBE_PATH))).toEqual([]);

  const control = probe('control.png');
  await fetch(control);
  await expect.poll(() => probeRequests()).toContain(control);
  expect(probeRequests()).toEqual([control]);
});

test('with externalMedia allow, the same deck does fetch (the request check can see one)', async () => {
  performance.clearResourceTimings();
  await showDeck(externalMediaDeck(), { externalMedia: 'allow' });
  await expect.poll(() => probeRequests().length).toBeGreaterThan(0);
});

test('links: only http(s) and mailto, opened in a new tab; javascript: and data: are dropped', async () => {
  const links: Relationship[] = [
    { id: 'rIdScript', type: 'hyperlink', target: 'javascript:alert(1)', external: true },
    { id: 'rIdData', type: 'hyperlink', target: 'data:text/html,<script>alert(1)</script>', external: true },
    { id: 'rIdWeb', type: 'hyperlink', target: 'https://example.com/report', external: true },
    { id: 'rIdMail', type: 'hyperlink', target: 'mailto:team@example.com', external: true },
  ];
  const shapes = ['rIdScript', 'rIdData', 'rIdWeb', 'rIdMail']
    .map((id, index) => textShape(`Link ${id}`, { link: id, y: 40 + index * 70 }))
    .join('');
  await showDeck(pptxBytes({ slides: [{ shapes, relationships: links }] }));

  const anchors = [...firstSlide()!.querySelectorAll('a')].map((anchor) => ({
    href: anchor.getAttribute('href'),
    target: anchor.getAttribute('target'),
    rel: anchor.getAttribute('rel'),
  }));
  expect(anchors).toEqual([
    { href: 'https://example.com/report', target: '_blank', rel: 'noopener noreferrer' },
    { href: 'mailto:team@example.com', target: '_blank', rel: 'noopener noreferrer' },
  ]);
  expect(referencesIn(firstSlide()!).join(' ')).not.toMatch(/javascript:|data:text\/html/);
  expect(firstSlide()!.textContent).toContain('Link rIdScript');
});

test('each slide is a group named "Slide N of M"; the toolbar shows the slide and zoom', async () => {
  await showDeck(pptxBytes({ slides: textSlides(3) }));
  expect(slideHosts()[0]!.getAttribute('role')).toBe('group');
  expect(slideHosts().map((host) => host.getAttribute('aria-label'))).toContain('Slide 1 of 3');
  expect(indicator()).toBe('Slide 1 of 3');
  expect(document.querySelector('[data-fs-part=pptx-zoom-level]')!.textContent).toBe('100%');
  expect(document.querySelector('[role=toolbar]')!.getAttribute('aria-label')).toBe('deck.pptx controls');

  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
  expect(document.querySelector('[data-fs-part=pptx-zoom-level]')!.textContent).toBe('125%');
  await expect
    .poll(() => document.querySelector('[data-fs-part=pptx-status]')!.textContent)
    .toBe('Slide 1 of 3, zoom 125%');
});

test('a new source keeps the current slide and zoom', async () => {
  const screen = await showDeck(pptxBytes({ slides: textSlides(12) }));
  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
  const scroller = document.querySelector<HTMLElement>('[data-fs-part=pages-viewport]')!;
  scroller.scrollTop = slideHosts()[0]!.getBoundingClientRect().height * 6;
  await expect.poll(() => indicator()).toMatch(/^Slide [6-8] of 12$/);
  const slideBefore = indicator();

  const refreshed = Array.from({ length: 12 }, (_, index) => ({
    shapes: textShape(`Refreshed ${index + 1}`),
  }));
  await screen.rerender(sized(<PptxViewer src={pptxBytes({ slides: refreshed })} fileName="deck.pptx" />));
  await expect
    .poll(() =>
      slideHosts()
        .map((host) => host.shadowRoot?.textContent)
        .join(),
    )
    .toContain('Refreshed');
  expect(indicator()).toBe(slideBefore);
  expect(document.querySelector('[data-fs-part=pptx-zoom-level]')!.textContent).toBe('125%');
});

test('a file that is not a presentation shows load_error; one over 200 MiB shows too_large unread', async () => {
  const errors: string[] = [];
  await render(
    sized(<PptxViewer src={new Uint8Array([1, 2, 3])} onError={(error) => errors.push(error.kind)} />),
  );
  await expect.poll(() => document.body.textContent).toContain(LOAD_ERROR_COPY);
  await cleanup();

  await render(
    sized(<PptxViewer src={new BlobOverTheLimit()} onError={(error) => errors.push(error.kind)} />),
  );
  await expect.poll(() => document.body.textContent).toContain(TOO_LARGE_COPY);
  expect(errors).toEqual(['load_error', 'too_large']);
});

test.each(['light', 'dark'] as const)('axe clean (%s)', async (theme) => {
  await showDeck(pptxBytes({ slides: textSlides(3) }), { theme });
  const results = await axe.run(document.querySelector('[data-fs-part=pptx-viewer]')!);
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
