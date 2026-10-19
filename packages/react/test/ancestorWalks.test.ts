import { expect, test } from 'vitest';
import { foldersBetween } from '../src/provider/reveal';
import { isUnderAHiddenName } from '../src/search/useFileSearch';

test('walking up from a path outside the root stops at the top instead of looping', () => {
  expect(isUnderAHiddenName('elsewhere/a.txt', 'workspace', new Set(['.git']))).toBe(false);
  expect(isUnderAHiddenName('.git/config', 'workspace', new Set(['.git']))).toBe(true);
  expect(foldersBetween('workspace', 'elsewhere/deep/a.txt')).toEqual(['elsewhere', 'elsewhere/deep']);
});

test('walking up from a path below the root stops at the root', () => {
  expect(isUnderAHiddenName('workspace/src/a.ts', 'workspace', new Set(['workspace']))).toBe(false);
  expect(foldersBetween('workspace', 'workspace/src/app/main.ts')).toEqual([
    'workspace/src',
    'workspace/src/app',
  ]);
});
