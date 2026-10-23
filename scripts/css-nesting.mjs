const COMMENT = /\/\*[\s\S]*?\*\//g;
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * The preludes (selectors, or at-rule heads such as `@media (…)`) of the blocks in `css` that sit inside a
 * style rule, which is what CSS nesting writes. Blocks inside at-rules only (`@layer`, `@media`,
 * `@supports`) are not nesting. Comments and quoted strings are skipped, so a `{` in a `content` or `url()`
 * string is not counted.
 *
 * @example
 * nestedRulesIn('@layer fs { .a { color: red; & .b { color: blue; } } }'); // ['& .b']
 */
export function nestedRulesIn(css) {
  const code = css.replace(COMMENT, '').replace(QUOTED, '""');
  const openBlocks = [];
  const nested = [];
  let preludeStart = 0;
  for (let index = 0; index < code.length; index++) {
    const character = code[index];
    if (character === '{') {
      const prelude = code.slice(preludeStart, index).trim();
      if (openBlocks.some((block) => !block.startsWith('@'))) nested.push(prelude);
      openBlocks.push(prelude);
      preludeStart = index + 1;
    } else if (character === '}') {
      openBlocks.pop();
      preludeStart = index + 1;
    } else if (character === ';') {
      preludeStart = index + 1;
    }
  }
  return nested;
}

/**
 * Throws, naming the first offending rules, when `css` uses CSS nesting. Shipped CSS stays flat so it works
 * in every supported browser and in tools that do not parse nesting (Ruling P4-6).
 *
 * @example
 * test('styles.css has no nested rules', () => assertNoNestedRules(readFileSync('dist/styles.css', 'utf8')));
 */
export function assertNoNestedRules(css, label = 'the stylesheet') {
  const nested = nestedRulesIn(css);
  if (nested.length > 0) {
    throw new Error(
      `${label} has ${nested.length} nested rule(s), such as ${nested.slice(0, 3).join(' | ')}. ` +
        'Flatten them at build time (postcss with postcss-nesting) or write them flat.',
    );
  }
}
