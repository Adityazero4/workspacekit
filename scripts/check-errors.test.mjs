import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorProblems } from './check-errors.mjs';

const docs = new Map([['server/handler', '## authorize\n\ntext\n']]);
const source = (text, file = 'packages/server/src/a.ts') => [{ path: file, text }];

test('accepts a developer error that ends with a docsLink to a real heading', () => {
  const text = "throw new TypeError(`x. Pass it. See ${docsLink('server/handler', 'authorize')}`);";
  assert.deepEqual(errorProblems({ sources: source(text), docs, allowList: [] }), []);
});

test('reports a throw whose message has no docsLink, with file and line', () => {
  const text = "const a = 1;\nthrow new Error('authorize is missing');";
  assert.deepEqual(errorProblems({ sources: source(text), docs, allowList: [] }), [
    'packages/server/src/a.ts:2 throw has no docsLink(...); add one or allow-list it in scripts/check-errors.mjs with a reason',
  ]);
});

test('finds a multi-line throw and a TypeError', () => {
  const text = "throw new TypeError(\n  'a ' +\n    'b',\n);";
  assert.equal(errorProblems({ sources: source(text), docs, allowList: [] }).length, 1);
});

test('skips a throw on the allow-list, matched by file and message text', () => {
  const text = "throw new Error('This TIFF has no image pages');";
  const allowList = [
    {
      file: 'packages/server/src/a.ts',
      message: 'This TIFF has no image pages',
      reason: 'shown in the viewer',
    },
  ];
  assert.deepEqual(errorProblems({ sources: source(text), docs, allowList }), []);
});

test('reports an allow-list entry that no longer matches a throw', () => {
  const allowList = [{ file: 'packages/server/src/a.ts', message: 'gone', reason: 'old' }];
  assert.deepEqual(errorProblems({ sources: source('const a = 1;'), docs, allowList }), [
    'allow-list entry for packages/server/src/a.ts matches no throw: "gone"',
  ]);
});

test('reports a docsLink to a missing page or a missing anchor', () => {
  const missingPage = "throw new Error(`x ${docsLink('nope', 'a')}`);";
  const missingAnchor = "throw new Error(`x ${docsLink('server/handler', 'nope')}`);";
  assert.deepEqual(errorProblems({ sources: source(missingPage), docs, allowList: [] }), [
    'packages/server/src/a.ts:1 docsLink page "nope" does not exist under apps/docs/content/docs',
  ]);
  assert.deepEqual(errorProblems({ sources: source(missingAnchor), docs, allowList: [] }), [
    'packages/server/src/a.ts:1 docsLink anchor "nope" is not a heading of "server/handler"',
  ]);
});

test('ignores test files and the docsLink definition itself', () => {
  const text = "throw new Error('plain');";
  assert.deepEqual(
    errorProblems({ sources: source(text, 'packages/server/src/a.test.ts'), docs, allowList: [] }),
    [],
  );
});
