import { expect, test } from 'vitest';
import { confineSlide } from '../src/slides';

function slideFrom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.style.position = 'relative';
  root.innerHTML = html;
  return root;
}

test('positions other than static, relative and absolute are removed, however they are written', () => {
  const root = slideFrom(
    '<div id="fixed" style="position: fixed; inset: 0"></div>' +
      '<div id="sticky" style="position: sticky !important"></div>' +
      '<div id="variable" style="position: var(--p)"></div>' +
      '<div id="absolute" style="position: absolute; left: 4px"></div>' +
      '<svg><rect id="svg" style="position: fixed" width="1" height="1"></rect></svg>',
  );
  confineSlide(root);
  const position = (id: string): string =>
    (root.querySelector(`#${id}`) as HTMLElement | SVGElement).style.getPropertyValue('position');
  expect(['fixed', 'sticky', 'variable', 'svg'].map(position)).toEqual(['', '', '', '']);
  expect(position('absolute')).toBe('absolute');
  expect(root.style.position).toBe('relative');
});

test('z-index is kept only as an integer up to 1000', () => {
  const root = slideFrom(
    ['1', '1000', '1001', '2147483647', 'calc(1e9)', 'var(--z)']
      .map((value, index) => `<div data-index="${index}" style="z-index: ${value}"></div>`)
      .join(''),
  );
  confineSlide(root);
  const kept = [...root.querySelectorAll<HTMLElement>('[data-index]')].map((element) => element.style.zIndex);
  expect(kept).toEqual(['1', '1000', '', '', '', '']);
});

test('styles and attributes that would fetch from outside the file are removed; blob: and data: stay', () => {
  const root = slideFrom(
    '<div id="remote" style="background-image: url(https://example.com/a.png); color: red"></div>' +
      '<div id="set" style="background-image: image-set(\'https://example.com/a.png\' 1x)"></div>' +
      '<div id="local" style="background-image: url(data:image/png;base64,AA==)"></div>' +
      '<img id="remote-img" src="https://example.com/a.png" srcset="data:image/png;base64,AA== 1x, https://example.com/b.png 2x">' +
      '<img id="blob-img" src="blob:https://app.example/1">' +
      '<svg><rect id="paint" fill="url(https://example.com/#g)" stroke="url(#local)"></rect>' +
      '<image id="svg-image" href="https://example.com/a.png"></image></svg>',
  );
  confineSlide(root);
  const element = (id: string): HTMLElement => root.querySelector<HTMLElement>(`#${id}`)!;
  expect(element('remote').style.backgroundImage).toBe('');
  expect(element('remote').style.color).toBe('red');
  expect(element('set').style.backgroundImage).toBe('');
  expect(element('local').style.backgroundImage).toContain('data:image/png');
  expect(element('remote-img').hasAttribute('src')).toBe(false);
  expect(element('remote-img').hasAttribute('srcset')).toBe(false);
  expect(element('blob-img').getAttribute('src')).toBe('blob:https://app.example/1');
  expect(element('paint').hasAttribute('fill')).toBe(false);
  expect(element('paint').getAttribute('stroke')).toBe('url(#local)');
  expect(element('svg-image').hasAttribute('href')).toBe(false);
});

test('links keep only absolute http(s) and mailto, opened in a new tab; handlers are removed', () => {
  const root = slideFrom(
    ['https://example.com/', 'mailto:a@example.com', 'javascript:alert(1)', '/relative', 'blob:https://x/1']
      .map((href, index) => `<a data-index="${index}" href="${href}" onclick="alert(1)">link</a>`)
      .join(''),
  );
  confineSlide(root);
  const links = [...root.querySelectorAll('a')].map((link) => [
    link.getAttribute('href'),
    link.getAttribute('target'),
    link.getAttribute('rel'),
    link.hasAttribute('onclick'),
  ]);
  expect(links).toEqual([
    ['https://example.com/', '_blank', 'noopener noreferrer', false],
    ['mailto:a@example.com', '_blank', 'noopener noreferrer', false],
    [null, null, null, false],
    [null, null, null, false],
    [null, null, null, false],
  ]);
});

test('object, embed, iframe, script and foreign objects are removed; the renderer’s own background object stays', () => {
  const root = slideFrom(
    '<object data="https://example.com/x"></object><embed src="https://example.com/x">' +
      '<iframe srcdoc="<p>x</p>"></iframe><script>window.ran = true</script>' +
      '<svg><foreignObject id="arbitrary"><div>html</div><p>more</p></foreignObject>' +
      '<foreignObject id="background"><div data-pptx-shape-background="true"></div></foreignObject></svg>',
  );
  confineSlide(root);
  expect(root.querySelectorAll('object, embed, iframe, script').length).toBe(0);
  expect(root.querySelector('#arbitrary')).toBeNull();
  expect(root.querySelector('#background')).not.toBeNull();
});

test('an xlink:href with an unsafe scheme is removed; one to a local fragment stays', () => {
  const root = slideFrom('<svg><use id="unsafe"></use><use id="local"></use></svg>');
  const xlink = 'http://www.w3.org/1999/xlink';
  root.querySelector('#unsafe')!.setAttributeNS(xlink, 'xlink:href', 'javascript:alert(1)');
  root.querySelector('#local')!.setAttributeNS(xlink, 'xlink:href', '#shape');
  confineSlide(root);
  expect(root.querySelector('#unsafe')!.hasAttributeNS(xlink, 'href')).toBe(false);
  expect(root.querySelector('#local')!.getAttributeNS(xlink, 'href')).toBe('#shape');
});

test('a link carrying a user name or password is dropped', () => {
  const root = slideFrom(
    '<a href="https://user:secret@example.com/">credentials</a><a href="https://user@example.com/">user</a>',
  );
  confineSlide(root);
  expect([...root.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([null, null]);
});

test('scanning for url( is linear: a value with 200,000 spaces after url( is checked at once', () => {
  const root = slideFrom('<svg><rect id="paint"></rect></svg>');
  const spaced = `url(${' '.repeat(200_000)}blob:x)`;
  root.querySelector('#paint')!.setAttribute('fill', spaced);
  root.querySelector('#paint')!.setAttribute('stroke', `url(${' '.repeat(200_000)}https://example.com/)`);
  const started = performance.now();
  confineSlide(root);
  const generousBudgetMs = 1000;
  expect(performance.now() - started).toBeLessThan(generousBudgetMs);
  expect(root.querySelector('#paint')!.getAttribute('fill')).toBe(spaced);
  expect(root.querySelector('#paint')!.hasAttribute('stroke')).toBe(false);
});

test('only CSS whitespace is skipped: a no-break or line-separator space before data: makes a relative URL, removed', () => {
  const root = slideFrom('<img id="image"><div id="styled"></div><svg><rect id="paint"></rect></svg>');
  for (const space of [' ', ' ']) {
    root.querySelector('#image')!.setAttribute('src', `${space}data:image/png;base64,AA==`);
    root.querySelector('#paint')!.setAttribute('fill', `url(${space}data:image/png;base64,AA==)`);
    root.querySelector<HTMLElement>('#styled')!.style.backgroundImage =
      `url("${space}data:image/png;base64,AA==")`;
    confineSlide(root);
    expect(root.querySelector('#image')!.hasAttribute('src')).toBe(false);
    expect(root.querySelector('#paint')!.hasAttribute('fill')).toBe(false);
    expect(root.querySelector<HTMLElement>('#styled')!.style.backgroundImage).toBe('');
  }
  root.querySelector('#paint')!.setAttribute('fill', 'url(\t\n data:image/png;base64,AA==)');
  confineSlide(root);
  expect(root.querySelector('#paint')!.hasAttribute('fill')).toBe(true);
});

test('style, link, base, meta and form elements are removed', () => {
  const root = slideFrom(
    '<style>:host { position: fixed }</style><link rel="stylesheet" href="data:text/css,a{color:red}">' +
      '<base href="https://example.com/"><meta http-equiv="refresh" content="0"><form action="#"><p>kept</p></form>',
  );
  confineSlide(root);
  expect(root.querySelectorAll('style, link, base, meta, form').length).toBe(0);
});

test('blob: and data: URLs stay only on media elements; elsewhere only #fragments', () => {
  const root = slideFrom(
    '<img id="image" src="data:image/png;base64,AA=="><video id="video" src="blob:https://app.example/1"></video>' +
      '<svg><image id="svg-image" href="data:image/png;base64,AA=="></image>' +
      '<use id="use-data" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></use><use id="use-local" href="#shape"></use>' +
      '<textPath id="path" href="#curve"></textPath></svg><div id="other" src="blob:https://app.example/2"></div>',
  );
  confineSlide(root);
  const attribute = (id: string, name: string): string | null =>
    root.querySelector(`#${id}`)!.getAttribute(name);
  expect(attribute('image', 'src')).toBe('data:image/png;base64,AA==');
  expect(attribute('video', 'src')).toBe('blob:https://app.example/1');
  expect(attribute('svg-image', 'href')).toBe('data:image/png;base64,AA==');
  expect(attribute('use-data', 'href')).toBeNull();
  expect(attribute('use-local', 'href')).toBe('#shape');
  expect(attribute('path', 'href')).toBe('#curve');
  expect(attribute('other', 'src')).toBeNull();
});

test('SVG animation elements are removed, so a <set> cannot change an href after the check', async () => {
  performance.clearResourceTimings();
  const probe = `${location.origin}/__pptx-smil-probe__/x.png`;
  const root = slideFrom(
    `<svg width="10" height="10"><image id="image" href="data:image/png;base64,AA==" width="10" height="10">` +
      `<set attributeName="href" to="${probe}" begin="0s"></set></image>` +
      `<rect><animate attributeName="x" to="5"></animate><animateTransform attributeName="transform"></animateTransform>` +
      '<animateMotion><mpath href="#path"></mpath></animateMotion><discard></discard></rect></svg>',
  );
  confineSlide(root);
  expect(root.querySelectorAll('set, animate, animateTransform, animateMotion, mpath, discard').length).toBe(
    0,
  );
  document.body.append(root);
  const control = `${location.origin}/__pptx-smil-probe__/control.png`;
  await fetch(control);
  const requested = (): string[] =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('smil-probe'));
  await expect.poll(requested).toContain(control);
  expect(requested()).toEqual([control]);
  root.remove();
});

test('an SVG link keeps no xlink:href to javascript:, and a web link is written as a plain href', () => {
  const xlink = 'http://www.w3.org/1999/xlink';
  const root = slideFrom('<svg><a id="script"><text>x</text></a><a id="web"><text>y</text></a></svg>');
  root.querySelector('#script')!.setAttributeNS(xlink, 'xlink:href', 'javascript:alert(1)');
  root.querySelector('#web')!.setAttributeNS(xlink, 'xlink:href', 'https://example.com/');
  confineSlide(root);
  expect(root.querySelector('#script')!.hasAttributeNS(xlink, 'href')).toBe(false);
  expect(root.querySelector('#script')!.hasAttribute('href')).toBe(false);
  expect(root.querySelector('#web')!.hasAttributeNS(xlink, 'href')).toBe(false);
  expect(root.querySelector('#web')!.getAttribute('href')).toBe('https://example.com/');
});

test('an SVG attribute with a CSS escape is removed, so u\\72l( or image-s\\65t( cannot hide a fetch', () => {
  const root = slideFrom('<svg><rect id="paint"></rect></svg>');
  const paint = root.querySelector('#paint')!;
  paint.setAttribute('fill', 'u\\72l(https://example.com/a.png)');
  paint.setAttribute('mask', 'u\\72l(https://example.com/m.svg#m)');
  paint.setAttribute('filter', 'image-s\\65t("https://example.com/a.png" 1x)');
  paint.setAttribute('stroke', 'red');
  confineSlide(root);
  expect(['fill', 'mask', 'filter'].filter((name) => paint.hasAttribute(name))).toEqual([]);
  expect(paint.getAttribute('stroke')).toBe('red');
});

test('a ping is removed from links', () => {
  const root = slideFrom('<a href="https://example.com/" ping="https://tracker.example.com/">link</a>');
  confineSlide(root);
  expect(root.querySelector('a')!.hasAttribute('ping')).toBe(false);
  expect(root.querySelector('a')!.getAttribute('href')).toBe('https://example.com/');
});
