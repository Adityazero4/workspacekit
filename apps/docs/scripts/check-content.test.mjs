import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkContent,
  checkLinks,
  checkPartNames,
  checkRecipePages,
  headingSlugs,
  readPages,
  readValidParts,
} from './check-content.mjs';

const fenceOf = (code, language = 'ts') => `\`\`\`${language}\n${code}\n\`\`\`\n`;
const page = (url, text) => ({ label: `${url}.mdx`, url, text });
const mentions = (problems, pattern) => problems.some((problem) => pattern.test(problem));

async function makeRepo(pages = {}, examples = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'check-content-'));
  const packageDir = path.join(root, 'packages', 'demo');
  await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  await mkdir(path.join(packageDir, 'src'));
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@scope/demo',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  );
  await writeFile(
    path.join(packageDir, 'dist', 'index.d.ts'),
    'export declare function hello(name: string): string;\n',
  );
  await writeFile(path.join(packageDir, 'dist', 'index.js'), 'export const hello = () => "";\n');
  await writeFile(
    path.join(packageDir, 'src', 'parts.ts'),
    "export const DEMO_PARTS: readonly ['demo-viewer', 'demo-error'] = ['demo-viewer', 'demo-error'];\n",
  );
  for (const [name, text] of Object.entries(pages)) {
    const file = path.join(root, 'apps', 'docs', 'content', 'docs', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  for (const [name, text] of Object.entries(examples)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return { root, options: { root, packages: ['demo'], partPackages: ['demo'] } };
}

test('a clean set of pages passes every check', async () => {
  const { options } = await makeRepo(
    {
      'index.mdx': '# Home\n\nSee [the recipe](/docs/recipes/theming#the-file) and [home](/).\n',
      'recipes/theming.mdx': '## The file\n\n<Include file="examples/recipes/theming.ts" />\n',
      'guide.mdx': `${fenceOf("import { hello } from '@scope/demo';\nhello('a');")}\nStyle \`[data-fs-part="demo-viewer"]\`.\n`,
    },
    { 'examples/recipes/theming.ts': 'export {};\n' },
  );
  assert.deepEqual(
    await checkContent({
      ...options,
      recipeSources: { '/docs/recipes/theming': ['examples/recipes/theming.ts'] },
    }),
    [],
  );
});

test('a recipe page with a pasted fence instead of the include fails', async () => {
  const problems = checkRecipePages(
    [page('/docs/recipes/s3', `${fenceOf('export const a = 1;')}\n<Include file="examples/a.ts" />\n`)],
    (await makeRepo({}, { 'examples/a.ts': 'x' })).root,
  );
  assert.ok(mentions(problems, /must not paste code/), problems.join('\n'));
});

test('a recipe page without an include fails, and so does an include of a missing or non-example file', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x', 'packages/secret.ts': 'x' });
  assert.ok(mentions(checkRecipePages([page('/docs/recipes/a', 'Only prose.')], root), /needs an <Include/));
  const missing = checkRecipePages([page('/docs/recipes/b', '<Include file="examples/none.ts" />')], root);
  assert.ok(mentions(missing, /must name an existing/), missing.join('\n'));
  const outside = checkRecipePages([page('/docs/recipes/c', '<Include file="packages/secret.ts" />')], root);
  assert.ok(mentions(outside, /must name an existing/), outside.join('\n'));
});

test('an include shown inside a code fence does not count, and non-recipe pages may use fences', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x' });
  const shown = checkRecipePages(
    [page('/docs/recipes/a', fenceOf('<Include file="examples/a.ts" />', 'text'))],
    root,
  );
  assert.ok(mentions(shown, /needs an <Include/), shown.join('\n'));
  assert.deepEqual(checkRecipePages([page('/docs/guide', fenceOf('export const a = 1;'))], root), []);
});

test('a TS fence that does not typecheck fails and names the page and line', async () => {
  const { options } = await makeRepo({ 'guide.mdx': `Intro\n\n${fenceOf("const count: number = 'many';")}` });
  const problems = await checkContent(options);
  assert.ok(mentions(problems, /guide\.mdx:4 TS2322/), problems.join('\n'));
});

test('a fence marked not-compiled is skipped, and a fence importing a non-public path fails', async () => {
  const skipped = await makeRepo({
    'a.mdx': fenceOf("// not-compiled: needs a bundler\nconst n: number = 'x';"),
  });
  assert.deepEqual(await checkContent(skipped.options), []);
  const internal = await makeRepo({
    'b.mdx': fenceOf("import { hello } from '@scope/demo/internal';\nhello('a');"),
  });
  assert.ok(mentions(await checkContent(internal.options), /not a public entry point/));
});

test('a link to a missing page fails', () => {
  const problems = checkLinks([page('/docs/a', 'See [b](/docs/missing).')]);
  assert.ok(mentions(problems, /\/docs\/missing does not match any page/), problems.join('\n'));
});

test('a link to a missing heading fails, on another page and on the same page', () => {
  const pages = [
    page('/docs/a', '[x](/docs/b#nope) and [y](#also-nope)\n\n## Here\n'),
    page('/docs/b', '## Real\n'),
  ];
  const problems = checkLinks(pages);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.deepEqual(checkLinks([page('/docs/a', '[x](#here) [y](/docs/a/#here)\n\n## Here\n')]), []);
});

test('links to the home page, site-root files and external sites pass, and links inside fences are ignored', () => {
  const text = `[home](/) [llms](/llms.txt) [full](/llms-full.txt) [out](https://example.com)\n\n${fenceOf('[bad](/docs/none)', 'text')}`;
  assert.deepEqual(checkLinks([page('/docs/a', text)]), []);
});

test('headingSlugs matches the slugs Fumadocs makes, including repeats and inline code', () => {
  const slugs = headingSlugs(
    '## Live updates\n\n## `canPerform` and more\n\n## Live updates\n\n```md\n## skipped\n```\n',
  );
  assert.deepEqual([...slugs], ['live-updates', 'canperform-and-more', 'live-updates-1']);
});

test('a part name that is in no PARTS fails, in a selector and as a classNames key', () => {
  const parts = new Set(['tree-row', 'workspace-files']);
  const selector = checkPartNames([page('/docs/a', 'Style `[data-fs-part="tree-rows"]`.')], parts);
  assert.ok(mentions(selector, /"tree-rows" is not a part name/), selector.join('\n'));
  const key = checkPartNames(
    [page('/docs/a', "const classNames = { 'workspace-files': 'a', 'made-up': 'b' };")],
    parts,
  );
  assert.equal(key.length, 1, key.join('\n'));
  assert.ok(mentions(key, /"made-up"/));
  const jsx = checkPartNames([page('/docs/a', '<Workspace classNames={{ "bad-part": "x" }} />')], parts);
  assert.ok(mentions(jsx, /"bad-part"/), jsx.join('\n'));
  assert.deepEqual(
    checkPartNames(
      [page('/docs/a', '`[data-fs-part=\'tree-row\']` and `data-fs-part="workspace-files"`')],
      parts,
    ),
    [],
  );
});

test('readValidParts reads the parts of every named package, and readPages gives each page its URL', async () => {
  const { root } = await makeRepo({
    'index.mdx': '# Home',
    'recipes/s3.mdx': '# S3',
    'concepts/adapter.mdx': '# A',
  });
  assert.deepEqual([...(await readValidParts(root, ['demo']))], ['demo-viewer', 'demo-error']);
  assert.deepEqual(
    (await readPages(root)).map((entry) => entry.url),
    ['/docs/concepts/adapter', '/docs', '/docs/recipes/s3'],
  );
});

const SOURCES = { '/docs/recipes/a': ['examples/a.ts'] };
const INCLUDE_A = '<Include file="examples/a.ts" />';

test('a recipe page fails on any fence other than a shell line, such as text, mdx or no language', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x' });
  for (const language of ['text', 'mdx', 'json', '']) {
    const problems = checkRecipePages(
      [page('/docs/recipes/a', `${INCLUDE_A}\n${fenceOf('code', language)}`)],
      root,
      SOURCES,
    );
    assert.ok(mentions(problems, /must not paste code/), `${language}: ${problems.join('\n')}`);
  }
  const shell = checkRecipePages(
    [page('/docs/recipes/a', `${INCLUDE_A}\n${fenceOf('npm i', 'sh')}`)],
    root,
    SOURCES,
  );
  assert.deepEqual(shell, []);
});

test('a recipe page fails on a raw pre block', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x' });
  const problems = checkRecipePages(
    [page('/docs/recipes/a', `${INCLUDE_A}\n<pre>code</pre>`)],
    root,
    SOURCES,
  );
  assert.ok(mentions(problems, /must not paste code/), problems.join('\n'));
});

test('a commented-out Include does not count', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x' });
  for (const hidden of [`{/* ${INCLUDE_A} */}`, `<!-- ${INCLUDE_A} -->`]) {
    const problems = checkRecipePages([page('/docs/recipes/a', hidden)], root, SOURCES);
    assert.ok(mentions(problems, /needs an <Include/), `${hidden}: ${problems.join('\n')}`);
  }
});

test('a recipe page must embed the file mapped to it, and a recipe page with no mapping fails', async () => {
  const { root } = await makeRepo({}, { 'examples/a.ts': 'x', 'examples/b.ts': 'x' });
  const wrong = checkRecipePages(
    [page('/docs/recipes/a', '<Include file="examples/b.ts" />')],
    root,
    SOURCES,
  );
  assert.ok(mentions(wrong, /must embed examples\/a\.ts/), wrong.join('\n'));
  const unmapped = checkRecipePages(
    [page('/docs/recipes/z', '<Include file="examples/b.ts" />')],
    root,
    SOURCES,
  );
  assert.ok(mentions(unmapped, /not in RECIPE_SOURCES/), unmapped.join('\n'));
});

test('an Include path follows the same rules as the component: dot segments, hidden folders, extensions, symlinks', async () => {
  const { root } = await makeRepo(
    {},
    {
      'examples/a.ts': 'x',
      'packages/secret.ts': 'x',
      'examples/.hidden/h.ts': 'x',
      'examples/data.json': '{}',
    },
  );
  for (const file of [
    'examples/../packages/secret.ts',
    'examples/./a.ts',
    'examples/.hidden/h.ts',
    'examples/data.json',
    'examples\\a.ts',
  ]) {
    const problems = checkRecipePages([page('/docs/recipes/a', `<Include file="${file}" />`)], root, {
      '/docs/recipes/a': [file],
    });
    assert.ok(mentions(problems, /must name an existing/), `${file}: ${problems.join('\n')}`);
  }
  await symlink(path.join(root, 'packages', 'secret.ts'), path.join(root, 'examples', 'link.ts'));
  const linked = checkRecipePages([page('/docs/recipes/a', '<Include file="examples/link.ts" />')], root, {
    '/docs/recipes/a': ['examples/link.ts'],
  });
  assert.ok(mentions(linked, /must name an existing/), linked.join('\n'));
});

test('relative links and single-quoted hrefs and reference definitions are checked', () => {
  const pages = [
    page('/docs/a', "[x](./b) [y](../c) [z](b)\n\n<a href='/docs/missing'>m</a>\n\n[ref]: /docs/gone\n"),
    page('/docs/b', ''),
  ];
  const problems = checkLinks(pages);
  assert.equal(problems.filter((problem) => /relative/.test(problem)).length, 3, problems.join('\n'));
  assert.ok(mentions(problems, /\/docs\/missing/), problems.join('\n'));
  assert.ok(mentions(problems, /\/docs\/gone/), problems.join('\n'));
  assert.deepEqual(checkLinks([page('/docs/a', 'Use `[x](./b)` in code.')]), []);
});

test('a link inside a commented-out block is ignored but a mailto and a protocol link pass', () => {
  assert.deepEqual(
    checkLinks([page('/docs/a', '[m](mailto:a@b.c) [h](https://x.y) {/* [bad](/docs/none) */}')]),
    [],
  );
});

test('a classNames object kept in a separate const is checked', () => {
  const parts = new Set(['tree-row']);
  const text = "const brand = { 'made-up': 'x', 'tree-row': 'y' };\n<Workspace classNames={brand} />";
  const problems = checkPartNames([page('/docs/a', text)], parts);
  assert.ok(mentions(problems, /"made-up"/), problems.join('\n'));
  const typed = checkPartNames(
    [page('/docs/a', "const brand: ClassNames = { bad: 'x' };\nconst classNames = brand;")],
    parts,
  );
  assert.ok(mentions(typed, /"bad"/), typed.join('\n'));
});

test('selectors in other forms are checked: ~=, unquoted and quoted', () => {
  const parts = new Set(['tree-row']);
  for (const selector of ['[data-fs-part~="nope"]', '[data-fs-part=nope]', "[data-fs-part='nope']"]) {
    assert.ok(mentions(checkPartNames([page('/docs/a', selector)], parts), /"nope"/), selector);
  }
});

test('readValidParts reads only the PARTS array, not other strings in the file, and fails closed when it is missing', async () => {
  const { root } = await makeRepo();
  await writeFile(
    path.join(root, 'packages', 'demo', 'src', 'parts.ts'),
    "export const DEMO_PARTS: readonly ['demo-viewer'] = ['demo-viewer'];\nexport const OTHER = 'not-a-part';\n",
  );
  assert.deepEqual([...(await readValidParts(root, ['demo']))], ['demo-viewer']);
  await assert.rejects(readValidParts(root, ['absent']), /packages\/absent\/src\/parts\.ts/);
  const missing = await makeRepo();
  const problems = await checkContent({ ...missing.options, partPackages: ['demo', 'absent'] });
  assert.ok(mentions(problems, /packages\/absent\/src\/parts\.ts/), problems.join('\n'));
});
