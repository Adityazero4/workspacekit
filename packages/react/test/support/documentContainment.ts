import { expect, test } from 'vitest';

interface ContainmentCase {
  hostile: string;
  html: string;
  expectContained: (root: HTMLElement) => void;
}

const TRACKER = 'https://tracker.example';
const NO_BREAK_SPACE = '\u00a0';

/**
 * The containment every document sanitizer keeps, as lists its tests read, so a package whose own lists
 * drift from them fails the shared table: SVG animation (SMIL) elements are removed, since they could change
 * an attribute after it was checked, and each URL attribute pointing outside the file is removed.
 *
 * @example
 * ```ts
 * DOCUMENT_CONTAINMENT_POLICY.smilElements.includes('set'); // true
 * ```
 */
export const DOCUMENT_CONTAINMENT_POLICY: {
  smilElements: readonly string[];
  urlAttributes: readonly string[];
} = {
  smilElements: ['animate', 'set', 'animatetransform', 'animatemotion', 'animatecolor', 'mpath', 'discard'],
  urlAttributes: ['src', 'href', 'xlink:href', 'poster', 'background', 'action', 'formaction', 'ping'],
};

const ELEMENT_FOR_URL_ATTRIBUTE: Record<string, string> = {
  src: '<img data-probe src="URL">',
  href: '<svg><image data-probe href="URL"></image></svg>',
  'xlink:href': '<svg><image data-probe xlink:href="URL"></image></svg>',
  poster: '<video data-probe poster="URL"></video>',
  background: '<table><tr><td data-probe background="URL">x</td></tr></table>',
  action: '<form data-probe action="URL"></form>',
  formaction: '<button data-probe formaction="URL">b</button>',
  ping: '<a data-probe href="https://ok.example/" ping="URL">a</a>',
};

const urlAttributeCases = (): ContainmentCase[] =>
  DOCUMENT_CONTAINMENT_POLICY.urlAttributes.map((attribute) => ({
    hostile: `${attribute} pointing outside the file`,
    html: ELEMENT_FOR_URL_ATTRIBUTE[attribute]!.replace('URL', `${TRACKER}/${attribute}`),
    expectContained: (root) => {
      expect(root.querySelector('[data-probe]')?.getAttribute(attribute) ?? null).toBeNull();
    },
  }));

const smilCases = (): ContainmentCase[] =>
  DOCUMENT_CONTAINMENT_POLICY.smilElements.map((element) => ({
    hostile: `the SMIL element ${element}`,
    html: `<svg><rect width="1" height="1"><${element} attributeName="fill" to="url(${TRACKER}/smil)"></${element}></rect></svg>`,
    expectContained: (root) => {
      const names = [...root.querySelectorAll('*')].map((found) => found.localName.toLowerCase());
      expect(names).not.toContain(element);
      expect(names).toContain('rect');
    },
  }));

const byId = (root: HTMLElement, id: string): HTMLElement => root.querySelector<HTMLElement>(`#${id}`)!;
const attributesOf = (root: HTMLElement, id: string): Record<string, string> =>
  Object.fromEntries([...byId(root, id).attributes].map(({ name, value }) => [name, value]));
const linksOf = (root: HTMLElement): Array<string | null> =>
  [...root.querySelectorAll('a')].map((link) => link.getAttribute('href'));

const STYLE_AND_LINK_CASES: ContainmentCase[] = [
  {
    hostile: 'a CSS-escaped url( in SVG paint attributes',
    html:
      `<svg><rect id="paint" width="1" height="1" fill="u\\72l(${TRACKER}/fill)" ` +
      `stroke="\\75 rl(${TRACKER}/stroke)" filter="url(#local)"></rect></svg>`,
    expectContained: (root) => {
      expect(attributesOf(root, 'paint')).toEqual({
        id: 'paint',
        width: '1',
        height: '1',
        filter: 'url(#local)',
      });
    },
  },
  {
    hostile: 'url( followed by a no-break space, which makes a relative URL on the app origin',
    html:
      `<span id="style" style="background-image: url(${NO_BREAK_SPACE}data:image/png;base64,AA==); color: red">s</span>` +
      `<svg><rect id="attribute" width="1" height="1" fill="url(${NO_BREAK_SPACE}#local)"></rect></svg>`,
    expectContained: (root) => {
      expect(byId(root, 'style').style.backgroundImage).toBe('');
      expect(byId(root, 'style').style.color).toBe('red');
      expect(byId(root, 'attribute').hasAttribute('fill')).toBe(false);
    },
  },
  {
    hostile: 'fixed and sticky positions, however they are written',
    html:
      '<span id="fixed" style="position: fixed; inset: 0">s</span>' +
      '<span id="sticky" style="position: sticky !important">s</span>' +
      '<span id="variable" style="--p: fixed; position: var(--p)">s</span>' +
      '<svg><rect id="svg" width="1" height="1" style="position: fixed"></rect></svg>' +
      '<span id="absolute" style="position: absolute">s</span>',
    expectContained: (root) => {
      const position = (id: string): string => byId(root, id).style.getPropertyValue('position');
      expect(['fixed', 'sticky', 'variable', 'svg'].map(position)).toEqual(['', '', '', '']);
      expect(position('absolute')).toBe('absolute');
    },
  },
  {
    hostile: 'a z-index above 1000, or one that is not a plain integer',
    html: ['1000', '1001', '2147483647', 'calc(1e9)', 'var(--z)']
      .map((value, index) => `<span data-z="${index}" style="z-index: ${value}">s</span>`)
      .join(''),
    expectContained: (root) => {
      const kept = [...root.querySelectorAll<HTMLElement>('[data-z]')].map((element) => element.style.zIndex);
      expect(kept).toEqual(['1000', '', '', '', '']);
    },
  },
  {
    hostile: 'javascript: and credentialed links',
    html:
      '<a href="javascript:alert(1)">a</a><a href="  JaVaScRiPt:alert(1)">b</a>' +
      '<a href="https://user:secret@ok.example/">c</a><a href="https://user@ok.example/">d</a>' +
      '<a href="https://:secret@ok.example/">e</a><a id="safe" href="https://ok.example/">f</a>',
    expectContained: (root) => {
      expect(linksOf(root)).toEqual([null, null, null, null, null, 'https://ok.example/']);
      expect(byId(root, 'safe').getAttribute('target')).toBe('_blank');
      expect(byId(root, 'safe').getAttribute('rel')).toBe('noopener noreferrer');
    },
  },
];

const HOSTILE_DOCUMENT_CASES: ContainmentCase[] = [
  ...STYLE_AND_LINK_CASES,
  {
    hostile: 'ping, which reports a click to another server',
    html: `<a id="link" href="https://ok.example/" ping="${TRACKER}/ping">a</a>`,
    expectContained: (root) => {
      expect(byId(root, 'link').hasAttribute('ping')).toBe(false);
      expect(byId(root, 'link').getAttribute('href')).toBe('https://ok.example/');
    },
  },
  {
    hostile: '<style>, <link>, <base> and <meta>',
    html:
      `<style>p { background: url(${TRACKER}/style) }</style><link rel="stylesheet" href="${TRACKER}/link">` +
      `<base href="${TRACKER}/"><meta http-equiv="refresh" content="0;${TRACKER}/meta"><p id="kept">p</p>` +
      `<svg><style>rect { fill: url(${TRACKER}/svg-style) }</style></svg>`,
    expectContained: (root) => {
      expect(root.querySelectorAll('style, link, base, meta')).toHaveLength(0);
      expect(byId(root, 'kept').textContent).toBe('p');
    },
  },
  {
    hostile: 'xlink:href on SVG links and images',
    html:
      '<svg><a id="script" xlink:href="javascript:alert(1)"><text>a</text></a>' +
      '<a id="document" xlink:href="data:text/html,x"><text>b</text></a>' +
      `<image id="remote" xlink:href="${TRACKER}/i.png"></image>` +
      '<image id="inline" xlink:href="data:image/png;base64,AA=="></image></svg>',
    expectContained: (root) => {
      for (const id of ['script', 'document', 'remote']) {
        expect(byId(root, id).getAttributeNames(), id).toEqual(['id']);
      }
      expect(byId(root, 'inline').getAttribute('xlink:href')).toBe('data:image/png;base64,AA==');
    },
  },
];

function inertRoot(html: string): HTMLElement {
  const root = document.implementation.createHTMLDocument('').createElement('div');
  root.innerHTML = html;
  return root;
}

function testContainmentCases(
  name: string,
  contain: (root: HTMLElement) => void,
  cases: ContainmentCase[],
): void {
  test.each(cases)(`${name} contains $hostile`, ({ html, expectContained }) => {
    const root = inertRoot(html);
    contain(root);
    expectContained(root);
  });
}

/**
 * Runs one table of hostile document markup (CSS escapes, no-break spaces before a URL, escaping positions
 * and stacks, script and credentialed links, `ping`, document-level elements, `xlink:href`, SMIL) through
 * `contain`, the sanitizer a document renderer applies before it shows rendered markup, so every document
 * renderer is held to the same containment.
 *
 * @example
 * ```ts
 * testDocumentContainment('confineSlide', confineSlide);
 * ```
 */
export function testDocumentContainment(name: string, contain: (root: HTMLElement) => void): void {
  testContainmentCases(name, contain, [...HOSTILE_DOCUMENT_CASES, ...urlAttributeCases(), ...smilCases()]);
}

/**
 * Runs the part of the table that the shared document-safety helpers decide on their own, whatever a
 * package's element and URL-attribute lists are: CSS escapes and no-break spaces in styles and SVG
 * attributes, escaping positions and stacks, script and credentialed links, and SMIL elements.
 *
 * @example
 * ```ts
 * testStyleAndLinkContainment('the renderer kit', containWithTheKit);
 * ```
 */
export function testStyleAndLinkContainment(name: string, contain: (root: HTMLElement) => void): void {
  testContainmentCases(name, contain, [...STYLE_AND_LINK_CASES, ...smilCases()]);
}
