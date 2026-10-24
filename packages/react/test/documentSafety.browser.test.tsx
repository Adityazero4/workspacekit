import { expect, test } from 'vitest';
import {
  confineDeclarations,
  keepWebOrMailLink,
  safeFontSource,
  SVG_ANIMATION_ELEMENTS,
  svgAttributeFetches,
} from '../src/renderer-kit';
import { testStyleAndLinkContainment } from './support/documentContainment';

const INLINE_SCHEMES = ['data:', '#'];

function containLink(link: Element, href: string): void {
  if (!keepWebOrMailLink(link, href)) link.removeAttribute('href');
}

function containAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (attribute.name === 'style') confineDeclarations((element as HTMLElement).style, INLINE_SCHEMES);
    else if (element.localName === 'a' && attribute.name === 'href') containLink(element, attribute.value);
    else if (svgAttributeFetches(element, attribute.value, INLINE_SCHEMES)) {
      element.removeAttributeNode(attribute);
    }
  }
}

function containWithTheKit(root: HTMLElement): void {
  for (const element of root.querySelectorAll('*')) {
    if (SVG_ANIMATION_ELEMENTS.includes(element.localName.toLowerCase())) element.remove();
    else containAttributes(element);
  }
}

testStyleAndLinkContainment('the renderer kit', containWithTheKit);

test('the SVG animation list cannot be changed at run time', () => {
  expect(Object.isFrozen(SVG_ANIMATION_ELEMENTS)).toBe(true);
});

const DATA_FONT = 'data:font/woff2;base64,AAAA';

test.each([
  [`url("${DATA_FONT}") format("woff2")`, `url("${DATA_FONT}") format("woff2")`],
  [
    `url(${DATA_FONT}) format(woff2) tech(variations)`,
    `url("${DATA_FONT}") format("woff2") tech(variations)`,
  ],
  ['local(Menlo), local("Courier New")', 'local("Menlo"), local("Courier New")'],
  [`url(\\64 ata:font/woff2;base64,AAAA)`, `url("${DATA_FONT}")`],
  ['url("htt\\70 s://evil.example/f.woff")', null],
  ['url("https://evil.example/f.woff"), local(Menlo)', 'local("Menlo")'],
  ['url(#font)', null],
  ['url("javascript:alert(1)")', null],
  ['url(" data:font/woff2;base64,AAAA")', null],
  [`url(var(--x))`, null],
  ['local(attr(x))', null],
  [`image-set("${DATA_FONT}" 1x)`, null],
  [`src("${DATA_FONT}")`, null],
  [`whatever("${DATA_FONT}")`, null],
  [`url("${DATA_FONT}") evil`, null],
  [`url("${DATA_FONT}") format("woff2") format("x")`, null],
  [`format("woff2") url("${DATA_FONT}")`, null],
  [`url("${DATA_FONT}") format("x(y)")`, null],
  ['local("a\\"b")', null],
  [`url("${DATA_FONT}") tech(1abc)`, null],
  [`url("${DATA_FONT}") tech(--a)`, null],
  [`url("${DATA_FONT}") tech(color-COLRv1)`, `url("${DATA_FONT}") tech(color-COLRv1)`],
  ['url(data:font/woff2,\\0 )', 'url("data:font/woff2,\uFFFD")'],
  ['url(data:font/woff2,\\d800 )', 'url("data:font/woff2,\uFFFD")'],
  ['local(A)), local(B)', null],
  ['garbage', null],
  ['', null],
  [`url("${DATA_FONT}"), garbage, local(Menlo)`, `url("${DATA_FONT}"), local("Menlo")`],
])('a font src of %j is rebuilt as %j', (source, expected) => {
  expect(safeFontSource(source)).toBe(expected);
});

test('an unclosed function padded with a million spaces is refused without backtracking', () => {
  expect(safeFontSource(`url(${' '.repeat(1_000_000)}x`)).toBeNull();
  expect(safeFontSource(`local(${' '.repeat(1_000_000)}a${' '.repeat(1_000_000)}`)).toBeNull();
});

test('a data: URL with quotes, backslashes or control characters is rebuilt with them escaped', () => {
  const source = String.raw`url("data:font/woff2,a\"b\\c\a d")`;
  const parsedValue = (value: string): string => {
    const probe = document.createElement('span');
    probe.style.setProperty('background-image', value);
    return probe.style.getPropertyValue('background-image');
  };
  expect(parsedValue(source)).not.toBe('');
  expect(parsedValue(safeFontSource(source)!)).toBe(parsedValue(source));
});
