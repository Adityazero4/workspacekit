import { expect, test } from 'vitest';
import { minimalChange } from '../src/remoteUpdate';

const applied = (current: string, next: string): string => {
  const { from, to, insert } = minimalChange(current, next);
  return current.slice(0, from) + insert + current.slice(to);
};

test('the change covers only the differing middle', () => {
  expect(minimalChange('const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;')).toEqual({
    from: 23,
    to: 24,
    insert: '3',
  });
  expect(minimalChange('abc', 'abXc')).toEqual({ from: 2, to: 2, insert: 'X' });
  expect(minimalChange('abXc', 'abc')).toEqual({ from: 2, to: 3, insert: '' });
});

test('prefix and suffix never overlap on repeated text', () => {
  for (const [current, next] of [
    ['aaaa', 'aa'],
    ['aa', 'aaaa'],
    ['abab', 'ab'],
    ['', 'x'],
    ['x', ''],
    ['same', 'same'],
  ] as const) {
    expect(applied(current, next), `${current} -> ${next}`).toBe(next);
  }
});
