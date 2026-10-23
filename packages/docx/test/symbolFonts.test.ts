import { expect, test } from 'vitest';
import { unicodeOfSymbolText } from '../src/symbolFonts';

test.each([
  ['Symbol', '\uF061\uF062\uF070', 'αβπ'],
  ['Symbol', 'abp', 'αβπ'],
  ['Symbol', '\uF0B3\uF0B9\uF0A5\uF0D6', '≥≠∞√'],
  ['Symbol', '\uF041\uF057', 'ΑΩ'],
  ['Wingdings', '\uF0FC', '✔'],
  ['Wingdings', '\uF0FE\uF0FD\uF0FB', '☑☒✗'],
  ['Wingdings', '\uF0A7\uF0D8\uF06C\uF06E', '▪➢●■'],
  ['Wingdings', '\uF09F\uF076\uF071\uF046', '•❖❑☞'],
  ['Wingdings', '\uF0EF\uF0F0', '⇦⇨'],
  ['"Wingdings", serif', '\uF0FC', '✔'],
  ['wingdings', '\uF0FC', '✔'],
  ['Symbol', 'a b', 'α β'],
])('symbol fonts map to Unicode: %s %j → %j', (fontFamily, text, expected) => {
  expect(unicodeOfSymbolText(fontFamily, text)).toBe(expected);
});

test('other fonts, and symbol text with a character that has no mapping, are left alone', () => {
  expect(unicodeOfSymbolText('Arial', '\uF061')).toBeNull();
  expect(unicodeOfSymbolText('Calibri, Symbol', 'a')).toBeNull();
  expect(unicodeOfSymbolText('Wingdings', '\uF0FC\uF09A')).toBeNull();
  expect(unicodeOfSymbolText('Symbol', '\uF0F0')).toBeNull();
  expect(unicodeOfSymbolText('Symbol', 'aĀ')).toBeNull();
});
