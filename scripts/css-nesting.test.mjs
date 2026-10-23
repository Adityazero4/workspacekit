import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoNestedRules, nestedRulesIn } from './css-nesting.mjs';

test('flat rules inside @layer and @media are not nesting', () => {
  const css = '@layer fs { .a { color: red; } @media (min-width: 1px) { .b { color: blue; } } }';
  assert.deepEqual(nestedRulesIn(css), []);
  assert.doesNotThrow(() => assertNoNestedRules(css));
});

test('finds nested selectors and at-rules nested in a style rule', () => {
  const css = '.a { color: red; & .b { color: blue; } .c { x: 1; } @media print { color: black; } }';
  assert.deepEqual(nestedRulesIn(css), ['& .b', '.c', '@media print']);
  assert.throws(() => assertNoNestedRules(css, 'dist/styles.css'), /dist\/styles\.css has 3 nested rule/);
});

test('ignores braces in comments and strings', () => {
  const css = '/* .x { .y {} } */ .a { content: "{ }"; background: url("data:a{b}c"); }';
  assert.deepEqual(nestedRulesIn(css), []);
});
