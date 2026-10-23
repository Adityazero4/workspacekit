import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportedNamesOf, PUBLIC_PACKAGES } from '../../../scripts/agent-docs.mjs';
import { apiEntries, assembleApiPages, missingExports } from './api-reference.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const entries = [
  { folderName: 'core', specifier: '@scope/core', moduleName: 'core/src' },
  { folderName: 'core', specifier: '@scope/core/http', moduleName: 'core/src/http' },
  { folderName: 'react', specifier: '@scope/react', moduleName: 'react/src' },
];

const modules = new Map([
  [
    'core/src',
    '# core/src\n\n## Functions\n\n### joinPath()\n\n```sh\n# not a heading\n```\n\nSee [FileInfo](../react/src.md#fileinfo) and [self](#joinpath).\n',
  ],
  [
    'core/src/http',
    '# core/src/http\n\n## Functions\n\n### httpAdapter()\n\n[root](../src.md) [name](../src.md#joinpath)\n',
  ],
  ['react/src', '# react/src\n\n### FileInfo\n'],
]);

test('assembleApiPages writes one page per package with a section per entry point', () => {
  const pages = assembleApiPages(modules, entries);
  assert.deepEqual([...pages.keys()].sort(), ['core.md', 'index.md', 'meta.json', 'react.md']);
  const core = pages.get('core.md');
  assert.match(core, /^---\ntitle: "@scope\/core"\n/);
  assert.match(core, /^## @scope\/core$/m);
  assert.match(core, /^## @scope\/core\/http$/m);
  assert.match(core, /^### Functions$/m);
  assert.match(core, /^#### joinPath\(\)$/m);
  assert.match(core, /^# not a heading$/m);
});

test('assembleApiPages rewrites links between modules and packages', () => {
  const core = assembleApiPages(modules, entries).get('core.md');
  assert.ok(core.includes('[FileInfo](/api/react#fileinfo)'));
  assert.ok(core.includes('[self](#joinpath)'));
  assert.ok(core.includes('[root](#scopecore)'));
  assert.ok(core.includes('[name](#joinpath)'));
  assert.ok(!core.includes('.md'));
});

test('assembleApiPages lists every package in the index and the navigation', () => {
  const pages = assembleApiPages(modules, entries);
  assert.ok(pages.get('index.md').includes('[@scope/react](/api/react)'));
  assert.deepEqual(JSON.parse(pages.get('meta.json')).pages, ['index', 'core', 'react']);
});

test('assembleApiPages is deterministic', () => {
  const first = assembleApiPages(modules, entries);
  const second = assembleApiPages(new Map([...modules].reverse()), entries);
  assert.deepEqual([...first], [...second]);
});

test('missingExports names an export that has no heading, and ignores () and escapes', () => {
  const pages = assembleApiPages(modules, entries);
  const expected = [
    { folderName: 'core', specifier: '@scope/core', names: ['joinPath'] },
    { folderName: 'core', specifier: '@scope/core/http', names: ['httpAdapter'] },
    { folderName: 'react', specifier: '@scope/react', names: ['FileInfo', 'Missing_name'] },
  ];
  assert.deepEqual(missingExports(pages, expected), [
    '@scope/react: the export Missing_name has no heading in /api/react.',
  ]);
});

test('missingExports ignores a same-named property or a name in another entry point section', () => {
  const pages = new Map([
    [
      'core.md',
      '## @scope/core\n\n### Interfaces\n\n#### Options\n\n##### joinPath\n\n## @scope/core/http\n\n#### httpAdapter()\n',
    ],
  ]);
  const expected = [
    { folderName: 'core', specifier: '@scope/core', names: ['joinPath', 'httpAdapter'] },
    { folderName: 'core', specifier: '@scope/core/http', names: ['httpAdapter', 'Options'] },
  ];
  assert.deepEqual(missingExports(pages, expected), [
    '@scope/core: the export joinPath has no heading in /api/core.',
    '@scope/core: the export httpAdapter has no heading in /api/core.',
    '@scope/core/http: the export Options has no heading in /api/core.',
  ]);
});

test('assembleApiPages throws when two exports on a page would share an anchor', () => {
  const duplicate = new Map([['core/src', '# core/src\n\n## Functions\n\n### a()\n\n### a()\n']]);
  assert.throws(() => assembleApiPages(duplicate, entries.slice(0, 1)), /core\.md.*"a".*same anchor/s);
});

test('assembleApiPages gives an export that two entry points share its own anchor', () => {
  const shared = new Map([
    ['core/src', '# core/src\n\n## Functions\n\n### joinPath()\n'],
    ['core/src/http', '# core/src/http\n\n## Functions\n\n### joinPath()\n'],
  ]);
  const pages = assembleApiPages(shared, entries.slice(0, 2));
  const core = pages.get('core.md');
  assert.match(core, /^#### joinPath\(\)$/m);
  assert.match(core, /^#### joinPath\(\) \[#scopecorehttp-joinpath\]$/m);
  const expected = [
    { folderName: 'core', specifier: '@scope/core', names: ['joinPath'] },
    { folderName: 'core', specifier: '@scope/core/http', names: ['joinPath'] },
  ];
  assert.deepEqual(missingExports(pages, expected), []);
});

test('assembleApiPages separates two exports whose names differ only by case', () => {
  const cased = new Map([
    ['core/src', '# core/src\n\n## Functions\n\n### fileInfo()\n\n## Type Aliases\n\n### FileInfo\n'],
  ]);
  const core = assembleApiPages(cased, entries.slice(0, 1)).get('core.md');
  assert.match(core, /^#### FileInfo \[#scopecore-fileinfo\]$/m);
});

test('assembleApiPages never gives two exports the same generated anchor', () => {
  const body = '# m\n\n## Functions\n\n### viewerError()\n\n## Interfaces\n\n### ViewerError\n';
  const pages = assembleApiPages(
    new Map([
      ['core/src', body],
      ['core/src/http', body],
    ]),
    entries.slice(0, 2),
  );
  assert.ok(pages.get('core.md'));
});

test('assembleApiPages leaves TSDoc text inert: no tags, expressions or include directives', () => {
  const hostile = new Map([
    [
      'core/src',
      '# core/src\n\n### f()\n\n<include>../../.env</include> and {process.env.X} and \\<escaped> and `<code>{kept}`\n\n<div onclick="x">raw</div>\n\n```ts\nconst a = <b>{c}</b>;\n```\n',
    ],
  ]);
  const page = assembleApiPages(hostile, entries.slice(0, 1)).get('core.md');
  assert.ok(!/(^|[^\\`])</m.test(page.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')), page);
  assert.ok(!/(^|[^\\`])\{/m.test(page.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')), page);
  assert.ok(page.includes('&lt;include>../../.env&lt;/include>'));
  assert.ok(page.includes('`<code>{kept}`'));
  assert.ok(page.includes('const a = <b>{c}</b>;'));
  assert.ok(page.includes('\\<escaped>'));
});

test('apiEntries maps every public export to its src module and skips stylesheets', async () => {
  const found = await apiEntries(ROOT, PUBLIC_PACKAGES);
  const specifiers = found.map((entry) => entry.specifier);
  assert.ok(specifiers.includes('@scope/core/http'));
  assert.ok(specifiers.includes('@scope/react/renderer-kit'));
  assert.ok(!specifiers.some((specifier) => specifier.endsWith('.css')));
  const http = found.find((entry) => entry.specifier === '@scope/core/http');
  assert.equal(http.moduleName, 'core/src/http');
  assert.equal(http.sourceFile, 'packages/core/src/http/index.ts');
  for (const entry of found) assert.ok(existsSync(path.join(ROOT, entry.sourceFile)), entry.sourceFile);
});

const generated = existsSync(path.join(ROOT, 'apps/docs/content/api/index.md'));
const built = existsSync(path.join(ROOT, 'packages/core/dist/index.d.ts'));

test(
  'every name exported from each public package and subpath has an API heading',
  { skip: !(generated && built) && 'run node apps/docs/scripts/api-reference.mjs after a build' },
  async () => {
    const pages = new Map();
    for (const folderName of PUBLIC_PACKAGES) {
      pages.set(
        `${folderName}.md`,
        await readFile(path.join(ROOT, 'apps/docs/content/api', `${folderName}.md`), 'utf8'),
      );
    }
    const expected = [];
    for (const folderName of PUBLIC_PACKAGES) {
      for (const entry of await exportedNamesOf(ROOT, folderName)) expected.push({ folderName, ...entry });
    }
    assert.deepEqual(missingExports(pages, expected), []);
  },
);
