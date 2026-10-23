import { afterEach, expect, test } from 'vitest';
import { scopeFontFamilies } from '../src/fontScope';
import { showRendered } from '../src/renderDocx';
import { safeStyles, sanitizeBody, type DocumentStyles } from '../src/sanitize';
import { unicodeOfSymbolText } from '../src/symbolFonts';

const inertDocument = (): Document => document.implementation.createHTMLDocument('');

function inertBody(html: string): HTMLElement {
  const body = inertDocument().createElement('div');
  body.innerHTML = html;
  return body;
}

afterEach(() => document.body.replaceChildren());

const PLANTED = `
  <p onclick="steal()" onmouseover="steal()" id="kept">text</p>
  <script>steal()</script><iframe srcdoc="x"></iframe><object data="x"></object><embed src="x">
  <form action="x"><input name="q"></form><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0;x">
  <base href="http://evil.example/"><style>p { color: red }</style>
  <a href="javascript:alert(1)">a</a><a href="  JaVaScRiPt:alert(1)">b</a><a href="data:text/html,x">c</a>
  <a href="vbscript:x">d</a><a href="blob:${location.origin}/x">e</a><a href="https://ok.example/">f</a>
  <a href="mailto:someone@example.com">g</a><a href="#here">h</a><a href="relative/page">i</a>
  <a href="/api/logout">j</a><a href="//evil.example/x">k</a><a href="HTTPS://OK.example/">l</a>
  <span id="s1" style="color: red; background-image: url(http://evil.example/x.png)">s</span>
  <span id="s2" style="background-image: url(data:image/png;base64,AAAA)">s</span>
  <span id="s3" style="--evil: url(http://evil.example/x); color: blue">s</span>
  <span id="s4" style="background: \\75 rl(http://evil.example/y)">s</span>
  <span id="s5" style="position: fixed; inset: 0; z-index: 2147483647; color: green">s</span>
  <span id="s6" style="position: sticky !important; z-index: 1000">s</span>
  <span id="s7" style="--p: fixed; position: var(--p); z-index: calc(1e9); color: teal">s</span>
  <span id="s8" style="position: relative; z-index: +1001">s</span>
  <img src="http://evil.example/i.png" alt="remote"><img src="data:image/png;base64,AAAA" alt="inline">
  <img srcset="data:image/png;base64,AAAA 1x, http://evil.example/a.png 2x" alt="set">
  <video poster="http://evil.example/p.png"></video>
  <table background="http://evil.example/t.png"><tr><td background="http://evil.example/d.png">x</td></tr></table>
  <input type="image" src="http://evil.example/i.png"><button formaction="http://evil.example/f">b</button>
  <math><mi href="https://evil.example/m">m</mi></math><p id="title">t</p><span id="images">i</span>
  <svg><rect fill="url(http://evil.example/#p)" stroke="url(#local)" style="position:fixed"></rect>
  <image href="http://evil.example/s.png"></image><a href="javascript:alert(1)"><text>t</text></a></svg>`;

test('the sanitizer drops scripts, frames, forms, on* attributes and every unsafe or relative href', () => {
  const body = inertBody(PLANTED);
  sanitizeBody(body);

  const forbidden = 'script, iframe, object, embed, form, link, meta, base, style';
  expect(body.querySelectorAll(forbidden)).toHaveLength(0);
  expect(body.querySelector('#kept')!.getAttributeNames()).toEqual(['id']);
  expect([...body.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
    null,
    null,
    null,
    null,
    null,
    'https://ok.example/',
    'mailto:someone@example.com',
    '#here',
    null,
    null,
    null,
    'https://ok.example/',
    null,
  ]);
  const external = body.querySelector('a[href^="https:"]')!;
  expect([external.getAttribute('target'), external.getAttribute('rel')]).toEqual([
    '_blank',
    'noopener noreferrer',
  ]);
  expect(body.querySelector('a[href="#here"]')!.hasAttribute('target')).toBe(false);
});

test('ids that name document properties are kept, so bookmarks such as "title" work in the shadow root', () => {
  const body = inertBody(PLANTED);
  sanitizeBody(body);
  expect([body.querySelector('p#title'), body.querySelector('span#images')]).not.toContain(null);
});

test('the sanitizer keeps layout styles and data: images but no external reference and no escape', () => {
  const body = inertBody(PLANTED);
  sanitizeBody(body);
  const style = (id: string): string => body.querySelector(`#${id}`)!.getAttribute('style') ?? '';

  expect(style('s1')).toBe('color: red;');
  expect(style('s2')).toMatch(/url\("?data:image\/png;base64,AAAA"?\)/);
  expect(style('s3')).toBe('color: blue;');
  expect(style('s4')).not.toMatch(/url|evil/);
  const declarationsOf = (id: string): string[] => {
    const declarations = body.querySelector<HTMLElement>(`#${id}`)!.style;
    return [...declarations].map((name) =>
      `${name}: ${declarations.getPropertyValue(name)} ${declarations.getPropertyPriority(name)}`.trim(),
    );
  };
  expect(declarationsOf('s5').join('; ')).not.toMatch(/position|z-index/);
  expect(declarationsOf('s5')).toContain('color: green');
  expect(declarationsOf('s6')).toEqual(['z-index: 1000']);
  expect(declarationsOf('s7')).toEqual(['--p: fixed', 'color: teal']);
  expect(declarationsOf('s8')).toEqual(['position: relative']);
  expect([...body.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
    null,
    'data:image/png;base64,AAAA',
    null,
  ]);
  expect(body.querySelector('img[alt=set]')!.hasAttribute('srcset')).toBe(false);
  const rect = body.querySelector('rect')!;
  expect([rect.getAttribute('fill'), rect.getAttribute('stroke')]).toEqual([null, 'url(#local)']);
  expect(rect.getAttribute('style') ?? '').toBe('');
  expect(body.querySelector('image')?.getAttribute('href') ?? null).toBeNull();
  expect(body.innerHTML).not.toContain('evil.example');
});

function withoutConstructedStyleSheets<Result>(run: () => Result): Result {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets')!;
  Reflect.deleteProperty(Document.prototype, 'adoptedStyleSheets');
  try {
    return run();
  } finally {
    Object.defineProperty(Document.prototype, 'adoptedStyleSheets', descriptor);
  }
}

const STYLE_PATHS = [
  ['constructed style sheets', (css: string[]) => safeStyles(css, inertDocument(), 'fs-docx-test-')],
  [
    'the <style> fallback',
    (css: string[]) => withoutConstructedStyleSheets(() => safeStyles(css, inertDocument(), 'fs-docx-test-')),
  ],
] as const;

const documentCssOf = (styles: DocumentStyles): string =>
  styles.element
    ? styles.element.textContent.split('\n').slice(1).join('\n')
    : styles.sheets
        .slice(1)
        .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
        .join('\n');

const BREAKOUT =
  'position:fixed!important;inset:0!important;z-index:2147483647!important;background:rgb(1,2,3)!important';
const SHADOW_BREAKOUTS = {
  scopeHost: `@scope/**/(:host)/**/{:scope{${BREAKOUT};contain:none!important}}`,
  scopeImplicit: `@scope{:scope{${BREAKOUT}}}`,
  scopeInLayer: `@layer a{@scope (:host){:scope{${BREAKOUT}}}}`,
  scopeInMedia: `@media all{@scope{:scope{${BREAKOUT}}}}`,
  scopeNested: `.x{@scope (:host){:scope{${BREAKOUT}}}}`,
  scopeTo: `@scope (:host) to (.never){:scope{${BREAKOUT}}}`,
  scopeAmpersand: `@scope (:host){&{${BREAKOUT}}}`,
  topScope: `:scope{${BREAKOUT}}`,
  topAmpersand: `&{${BREAKOUT}}`,
  escapedHost: `:\\68ost{${BREAKOUT}}`,
  hostFunction: `:host(div){${BREAKOUT}}`,
  hostInIs: `:is(:host){${BREAKOUT}}`,
  hostContext: `:host-context(body){${BREAKOUT}}`,
  startingStyle: `@starting-style{:host{${BREAKOUT}}}`,
  supports: `@supports (display:block){:host{${BREAKOUT}}}`,
  container: `@container (min-width:0){:host{${BREAKOUT}}}`,
};

function hostStyledBy(styles: DocumentStyles): CSSStyleDeclaration {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  showRendered(shadowRoot, { nodes: [document.createElement('span')], styles });
  return getComputedStyle(host);
}

test.each(STYLE_PATHS)('no document rule can style the viewer itself (%s)', (_, safeStylesOf) => {
  const unstyled = hostStyledBy(safeStylesOf(['.docx { color: red }']));
  const control = [unstyled.position, unstyled.backgroundColor, unstyled.zIndex, unstyled.contain];
  expect(unstyled.position).toBe('relative');
  for (const [name, css] of Object.entries(SHADOW_BREAKOUTS)) {
    const styles = safeStylesOf([css]);
    expect(documentCssOf(styles), name).toBe('');
    const computed = hostStyledBy(styles);
    expect([computed.position, computed.backgroundColor, computed.zIndex, computed.contain], name).toEqual(
      control,
    );
  }
});

test.each(STYLE_PATHS)(
  'kept rules cannot fetch, reach the viewport or stack above the app (%s)',
  (_, safeStylesOf) => {
    const css = documentCssOf(
      safeStylesOf([
        `@import url(http://evil.example/a.css);
      @namespace svg url(http://www.w3.org/2000/svg);
      .a { color: red; background: url(http://evil.example/b.png) }
      @media screen { .b { background-image: url('http://evil.example/c.png'); color: blue } }
      @font-face { font-family: Remote; src: url(http://evil.example/f.woff) }
      @font-face { font-family: Inline; src: url(data:font/woff2;base64,AAAA) }
      @keyframes rise { from { z-index: 5000; opacity: 0 } to { opacity: 1 } }
      .c { --v: url(http://evil.example/d); --theme-color: #123456; content: "ok" }
      @property --p { syntax: '<url>'; inherits: false; initial-value: url(http://evil.example/e) }
      .d { background: image-set("http://evil.example/g.png" 1x); color: green }
      .e { background: url(null); position: fixed; z-index: 99999 }
      a { position: sticky !important; inset: 0 }
      .f { position: relative; z-index: 10 }
      .g { --p: fixed; position: var(--p) !important; z-index: calc(1e9) }
      .h { z-index: +1001 } .i { z-index: 1e3 } .j { position: -webkit-sticky }`,
      ]),
    );
    expect(css).not.toMatch(
      /evil\.example|null|@property|@import|sticky|5000|99999|var\(--p\)|calc|1001|1e3/,
    );
    expect(css.match(/(?<![-\w])position: [a-z-]+/g)).toEqual(['position: relative']);
    expect(css).toContain('@namespace svg');
    for (const kept of [
      'color: red',
      'color: blue',
      'color: green',
      'Inline',
      'data:font/woff2',
      '#123456',
      '@keyframes',
    ]) {
      expect(css).toContain(kept);
    }
  },
);

test('an app control outside the viewer stays on top of a document that tries to cover the page', () => {
  const button = document.createElement('button');
  button.textContent = 'App action';
  button.style.cssText = 'display: block; width: 200px; height: 40px';
  const host = document.createElement('div');
  host.style.cssText = 'height: 200px; margin-top: 100px';
  document.body.append(button, host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const body = inertBody(
    '<a href="https://ok.example/" style="position: fixed; inset: 0; z-index: 2147483647">x</a>',
  );
  sanitizeBody(body);
  const css = [`a{position:fixed;inset:0;z-index:2147483647}${Object.values(SHADOW_BREAKOUTS).join('')}`];
  showRendered(shadowRoot, {
    nodes: [...body.childNodes],
    styles: safeStyles(css, inertDocument(), 'fs-docx-test-'),
  });

  const buttonBox = button.getBoundingClientRect();
  expect(document.elementFromPoint(buttonBox.left + 10, buttonBox.top + 10)).toBe(button);
  expect(getComputedStyle(host).position).toBe('relative');
});

test.each(STYLE_PATHS)(
  'a consumer turning containment off cannot let var() routes out (%s)',
  (_, safeStylesOf) => {
    const consumer = document.createElement('style');
    consumer.textContent = '[data-viewer] { contain: none !important; overflow: visible !important }';
    const button = document.createElement('button');
    button.style.cssText = 'display: block; width: 200px; height: 40px';
    const host = document.createElement('div');
    host.dataset.viewer = '';
    host.style.cssText = 'height: 100px; margin-top: 100px';
    document.head.append(consumer);
    document.body.append(button, host);
    try {
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const body = inertBody(
        '<a class="x" style="position: var(--p); z-index: var(--z)">x</a><p class="y">y</p>',
      );
      sanitizeBody(body);
      const css =
        '.x, .y { --p: fixed; --z: 2147483647; position: var(--p); z-index: var(--z); inset: 0; background: red }';
      showRendered(shadowRoot, { nodes: [...body.childNodes], styles: safeStylesOf([css]) });
      expect(getComputedStyle(host).contain).toBe('paint');
      const buttonBox = button.getBoundingClientRect();
      expect(document.elementFromPoint(buttonBox.left + 10, buttonBox.top + 10)).toBe(button);
      expect(getComputedStyle(shadowRoot.querySelector('.x')!).position).toBe('static');
    } finally {
      consumer.remove();
    }
  },
);

test.each(STYLE_PATHS)(
  "a document's font faces are renamed for it alone, with the rules that use them (%s)",
  (_, safeStylesOf) => {
    const styles = safeStylesOf([
      `@font-face { font-family: Arial; src: local(Menlo) }
    @font-face { font-family: "Probe Sans"; src: url(data:font/woff2;base64,AAAA) }
    .a { font-family: Arial, serif } .b { font: 12px "Probe Sans", sans-serif } .c { font-family: serif, Georgia }`,
    ]);
    const css = documentCssOf(styles);
    expect(css).not.toMatch(/font-family: (Arial|"Probe Sans")/);
    expect(css).toMatch(/@font-face \{ font-family: "?fs-docx-test-Arial"?;/);
    expect(css).toMatch(/@font-face \{ font-family: "?fs-docx-test-Probe Sans"?;/);
    expect(css).toMatch(/\.a \{ font-family: "?fs-docx-test-Arial"?, serif;/);
    expect(css).toMatch(/"?fs-docx-test-Probe Sans"?, sans-serif/);
    expect(css).toContain('font-family: serif, Georgia');
    expect(styles.fonts.families).toEqual(
      new Map([
        ['arial', '"fs-docx-test-Arial"'],
        ['probe sans', '"fs-docx-test-Probe Sans"'],
      ]),
    );
  },
);

const SPACES = ' '.repeat(200_000);
const GENEROUS_BOUND_MS = 100;

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

test('url( followed by 200,000 spaces is judged in bounded work, in attributes and inline styles', () => {
  const body = inertDocument().createElement('div');
  body.innerHTML = '<svg><rect id="r"></rect></svg><span id="c">c</span>';
  body.querySelector('rect')!.setAttribute('fill', `url(${SPACES}x)`);
  body.querySelector<HTMLElement>('#c')!.style.setProperty('--a', `url(${SPACES}x)`);
  expect(elapsedMs(() => sanitizeBody(body))).toBeLessThan(GENEROUS_BOUND_MS);
  expect(body.querySelector('rect')!.hasAttribute('fill')).toBe(false);
  expect(body.querySelector<HTMLElement>('#c')!.style.getPropertyValue('--a')).toBe('');
});

test('a 200,000-space font family is split and scoped in bounded work', () => {
  const declarations = inertDocument().createElement('span').style;
  declarations.setProperty('font-family', `"a${SPACES}b", Arial, serif`);
  const scope = { prefix: 'p-', families: new Map([['arial', '"p-Arial"']]) };
  expect(elapsedMs(() => scopeFontFamilies(declarations, scope))).toBeLessThan(GENEROUS_BOUND_MS);
  expect(declarations.getPropertyValue('font-family')).toMatch(/, "?p-Arial"?, serif$/);
  expect(elapsedMs(() => unicodeOfSymbolText(`"a${SPACES}b", Symbol`, 'x'))).toBeLessThan(GENEROUS_BOUND_MS);
});

test('only CSS whitespace is skipped before a data: URL, so a non-breaking space cannot pass as one', () => {
  const noBreakSpace = String.fromCharCode(0xa0);
  const lineSeparator = String.fromCharCode(0x2028);
  const body = inertBody(
    `<span id="nbsp" style="background-image: url(${noBreakSpace}data:image/png;base64,AAAA)">a</span>` +
      `<span id="quoted" style='background-image: url("${lineSeparator}data:image/png;base64,AAAA")'>b</span>` +
      `<span id="plain" style="background-image: url( \tdata:image/png;base64,AAAA)">c</span>`,
  );
  sanitizeBody(body);
  const imageOf = (id: string): string => body.querySelector<HTMLElement>(`#${id}`)!.style.backgroundImage;
  expect(imageOf('nbsp')).toBe('');
  expect(imageOf('quoted')).toBe('');
  expect(imageOf('plain')).toContain('data:image/png');
});
