import {
  createVisibleRowIndex,
  mergeListing,
  emptyTree,
  type Entry,
  type VisibleRowIndex,
} from '@scope/core';
import { describe, expect, test } from 'vitest';
import { treeKeyIntent, type TreeKeyIntent } from '../src/tree/keyboard';
import { findTypeahead, typeaheadStep } from '../src/tree/typeahead';

const dir = (path: string): Entry => ({ path, name: path.split('/').pop()!, kind: 'directory' });
const file = (path: string): Entry => ({ path, name: path.split('/').pop()!, kind: 'file' });

const tree = mergeListing(emptyTree(), '', 2, [
  dir('a'),
  dir('a/b'),
  file('a/c.txt'),
  dir('d'),
  dir('g'),
  file('e.txt'),
]);
const index: VisibleRowIndex = createVisibleRowIndex(tree, {
  root: '',
  expanded: new Set(['a', 'g']),
  sort: { by: 'name', direction: 'asc' },
});

interface Case {
  key: string;
  at: string;
  mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean };
  mac?: boolean;
  want: TreeKeyIntent;
  why?: string;
}
const run = (c: Case): TreeKeyIntent =>
  treeKeyIntent(
    {
      key: c.key,
      ctrlKey: !!c.mods?.ctrl,
      metaKey: !!c.mods?.meta,
      shiftKey: !!c.mods?.shift,
      altKey: !!c.mods?.alt,
    },
    index.rowAt(index.indexOf(c.at)),
    index,
    c.mac,
  );
const none: TreeKeyIntent = { kind: 'none' };
const name = (c: Case): string =>
  `${Object.keys(c.mods ?? {}).join('+')}${c.mods ? '+' : ''}${c.key} on ${c.at}${c.mac ? ' (Mac)' : ''}${c.why ? `: ${c.why}` : ''}`;

test('fixture rows: a (open), a/b, a/c.txt, d, g (open, nothing loaded), e.txt', () => {
  expect(Array.from({ length: index.count }, (_, i) => index.rowAt(i).path)).toEqual([
    'a',
    'a/b',
    'a/c.txt',
    'd',
    'g',
    'e.txt',
  ]);
});

const TABLE: Record<string, Case[]> = {
  'Down / Up: next / previous row': [
    { key: 'ArrowDown', at: 'a', want: { kind: 'move', index: 1 } },
    { key: 'ArrowDown', at: 'e.txt', want: none },
    { key: 'ArrowUp', at: 'a/b', want: { kind: 'move', index: 0 } },
    { key: 'ArrowUp', at: 'a', want: none },
    { key: 'ArrowDown', at: 'a', mods: { alt: true }, want: none },
  ],
  'Right: expand a collapsed folder, enter an expanded one, else nothing': [
    { key: 'ArrowRight', at: 'd', want: { kind: 'expand', path: 'd' } },
    { key: 'ArrowRight', at: 'a', want: { kind: 'move', index: 1 } },
    { key: 'ArrowRight', at: 'g', want: none, why: 'expanded, no child rows yet' },
    { key: 'ArrowRight', at: 'a/c.txt', want: none },
  ],
  'Left: collapse an expanded folder, else move to the parent': [
    { key: 'ArrowLeft', at: 'a', want: { kind: 'collapse', path: 'a' } },
    { key: 'ArrowLeft', at: 'a/c.txt', want: { kind: 'move', index: 0 } },
    { key: 'ArrowLeft', at: 'a/b', want: { kind: 'move', index: 0 } },
    { key: 'ArrowLeft', at: 'd', want: none, why: 'parent is the root' },
  ],
  'Home / End: first / last row': [
    { key: 'Home', at: 'd', want: { kind: 'move', index: 0 } },
    { key: 'End', at: 'a', want: { kind: 'move', index: 5 } },
  ],
  '*: expand all siblings': [
    { key: '*', at: 'd', want: { kind: 'expandSiblings', parent: '' } },
    { key: '*', at: 'a/c.txt', mods: { shift: true }, want: { kind: 'expandSiblings', parent: 'a' } },
  ],
  'Enter: open': [
    { key: 'Enter', at: 'a/c.txt', want: { kind: 'open', path: 'a/c.txt' } },
    { key: 'Enter', at: 'd', want: { kind: 'open', path: 'd' } },
  ],
  'F2: rename': [{ key: 'F2', at: 'e.txt', want: { kind: 'rename', path: 'e.txt' } }],
  'Delete / Backspace (Mac): delete': [
    { key: 'Delete', at: 'e.txt', want: { kind: 'delete', path: 'e.txt' } },
    { key: 'Backspace', at: 'e.txt', mac: true, want: { kind: 'delete', path: 'e.txt' } },
    { key: 'Backspace', at: 'e.txt', want: none },
  ],
  'Shift+F10 / ContextMenu: context menu': [
    { key: 'F10', at: 'd', mods: { shift: true }, want: { kind: 'menu', path: 'd' } },
    { key: 'ContextMenu', at: 'd', want: { kind: 'menu', path: 'd' } },
    { key: 'F10', at: 'd', want: none },
  ],
  'Ctrl/Cmd+X, C, V: cut, copy, paste': [
    { key: 'x', at: 'e.txt', mods: { ctrl: true }, want: { kind: 'clipboard', op: 'cut', path: 'e.txt' } },
    {
      key: 'c',
      at: 'e.txt',
      mods: { meta: true },
      mac: true,
      want: { kind: 'clipboard', op: 'copy', path: 'e.txt' },
    },
    {
      key: 'V',
      at: 'd',
      mods: { ctrl: true },
      want: { kind: 'clipboard', op: 'paste', path: 'd' },
      why: 'Caps Lock',
    },
    { key: 'c', at: 'e.txt', mods: { ctrl: true }, mac: true, want: none, why: 'Ctrl is not Mod on a Mac' },
    { key: 'c', at: 'e.txt', mods: { meta: true }, want: none },
    { key: 'c', at: 'e.txt', mods: { ctrl: true, shift: true }, want: none },
  ],
  'Printable characters: type-ahead': [
    { key: 'b', at: 'a', want: { kind: 'typeahead', char: 'b' } },
    { key: 'B', at: 'a', mods: { shift: true }, want: { kind: 'typeahead', char: 'B' } },
    { key: 'é', at: 'a', want: { kind: 'typeahead', char: 'é' } },
    { key: 'b', at: 'a', mods: { ctrl: true }, want: none },
    { key: 'Tab', at: 'a', want: none },
  ],
};

describe.each(Object.entries(TABLE))('%s', (_, cases) => {
  test.each(cases.map((c) => [name(c), c] as const))('%s', (_n, c) => expect(run(c)).toEqual(c.want));
});

describe('type-ahead matching', () => {
  const namesTree = mergeListing(
    emptyTree(),
    '',
    1,
    ['Apple', 'banana', 'Éclair', 'berry', 'apricot'].map((n) => file(n)),
  );
  const nameIndex = createVisibleRowIndex(namesTree, {
    root: '',
    expanded: new Set(),
    sort: { by: 'name', direction: 'asc' },
  });
  const names = Array.from({ length: nameIndex.count }, (_, i) => nameIndex.rowAt(i).entry.name);
  const at = (n: string): number => names.indexOf(n);

  test('fixture rows are in name order', () => {
    expect(names).toEqual(['Apple', 'apricot', 'banana', 'berry', 'Éclair']);
  });

  test('one character searches after the current row and wraps', () => {
    expect(names[findTypeahead(nameIndex, at('Apple'), 'a')]).toBe('apricot');
    expect(names[findTypeahead(nameIndex, at('apricot'), 'a')]).toBe('Apple');
    expect(names[findTypeahead(nameIndex, at('banana'), 'b')]).toBe('berry');
    expect(findTypeahead(nameIndex, at('banana'), 'z')).toBe(-1);
  });

  test('longer prefixes include the current row; repeating one character cycles', () => {
    expect(names[findTypeahead(nameIndex, at('banana'), 'ban')]).toBe('banana');
    expect(names[findTypeahead(nameIndex, at('berry'), 'bb')]).toBe('banana');
  });

  test('case- and NFC-insensitive', () => {
    const decomposedCapitalEAcute = 'E\u0301';
    expect(names[findTypeahead(nameIndex, at('Apple'), `${decomposedCapitalEAcute}C`)]).toBe('Éclair');
    expect(names[findTypeahead(nameIndex, at('banana'), 'APP')]).toBe('Apple');
  });

  test('the buffer resets after 500 ms', () => {
    let buffer = typeaheadStep(null, 'b', 1000);
    buffer = typeaheadStep(buffer, 'e', 1400);
    expect(buffer.text).toBe('be');
    buffer = typeaheadStep(buffer, 'r', 1899);
    expect(buffer).toEqual({ text: 'ber', lastKeyAt: 1899 });
    expect(typeaheadStep(buffer, 'a', 2400).text).toBe('a');
  });
});
