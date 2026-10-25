import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameProblems } from './check-names.mjs';

test('reports the retired scope and docs domain with file and line', () => {
  const problems = nameProblems([
    { path: 'README.md', text: 'intro\nnpm install @scope/core\n' },
    { path: 'packages/x/src/a.ts', text: 'const url = "https://docs.example.invalid";' },
    { path: 'scripts/x.test.mjs', text: 'assert.match(out, /@scope\\/core/);' },
  ]);
  assert.deepEqual(problems, [
    'README.md:2 @scope/',
    'packages/x/src/a.ts:1 docs.example.invalid',
    'scripts/x.test.mjs:1 @scope\\/',
  ]);
});

test('ignores the CSS @scope at-rule, history folders and its own files', () => {
  const problems = nameProblems([
    { path: 'packages/docx/src/sanitize.ts', text: 'drops @scope { } and @layer rules' },
    { path: 'internal/plans/plan-1.md', text: '@scope/core' },
    { path: 'scripts/check-names.mjs', text: "'@scope/'" },
  ]);
  assert.deepEqual(problems, []);
});

test('accepts the final names', () => {
  assert.deepEqual(
    nameProblems([
      {
        path: 'README.md',
        text: 'npm install @workspacekit/core https://adityazero4.github.io/workspacekit',
      },
    ]),
    [],
  );
});
