import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgentDocs, extractFences, generateAgentDocs } from './agent-docs.mjs';

const REACT_PACKAGE = fileURLToPath(new URL('../packages/react', import.meta.url));
const DOCS_URL = 'https://docs.example.invalid';
const MISTAKES = 'Never ship without `authorize`.\n';
const START = '<!-- common-mistakes:start -->';
const END = '<!-- common-mistakes:end -->';

const agentsMd = (block) => `# Demo agents\n\n${START}\n${block}${END}\n`;
const readme = (fence = '') =>
  `# @scope/demo\n\nA demo package.\n\n## Install\n\nRun the installer.\n\n[API reference](${DOCS_URL}/api/demo)\n\n${fence}`;
const fenceOf = (code, language = 'ts') => `\`\`\`${language}\n${code}\n\`\`\`\n`;

async function makeRepo({
  readmeText = readme(),
  agents = agentsMd(MISTAKES),
  files = ['dist', 'README.md', 'AGENTS.md', 'llms.txt'],
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-docs-'));
  const packageDir = path.join(root, 'packages', 'demo');
  await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  await mkdir(path.join(root, 'docs-src'));
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@scope/demo',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files,
    }),
  );
  await writeFile(
    path.join(packageDir, 'dist', 'index.d.ts'),
    '/**\n * Says hello.\n */\nexport declare function hello(name: string): string;\nexport type Greeting = string;\n',
  );
  await writeFile(path.join(packageDir, 'dist', 'index.js'), 'export const hello = () => "";\n');
  await writeFile(path.join(packageDir, 'README.md'), readmeText);
  await writeFile(path.join(packageDir, 'AGENTS.md'), agents);
  await writeFile(path.join(root, 'docs-src', 'common-mistakes.md'), MISTAKES);
  return { root, packageDir, options: { root, packages: ['demo'], docsUrl: DOCS_URL } };
}

const generated = async (repoOptions) => {
  const repo = await makeRepo(repoOptions);
  await generateAgentDocs(repo.options);
  return repo;
};

test('a freshly generated repo passes, and llms.txt names every export and links the docs', async () => {
  const { options, packageDir } = await generated();
  assert.deepEqual(await checkAgentDocs(options), []);
  const llms = await readFile(path.join(packageDir, 'llms.txt'), 'utf8');
  assert.match(llms, /`hello`: Says hello\./);
  assert.match(llms, /`Greeting`/);
  assert.ok(llms.includes(`${DOCS_URL}/api/demo`));
});

test('llms.txt repeats the README install command, including npm create', async () => {
  const withCommand = (command) =>
    readme(fenceOf(command, 'sh')).replace('Run the installer.', 'Run the installer.\n');
  for (const command of ['npm create @scope/demo my-app', 'npm install @scope/demo react']) {
    const { packageDir } = await generated({ readmeText: withCommand(command) });
    assert.ok(
      (await readFile(path.join(packageDir, 'llms.txt'), 'utf8')).includes(`- Install: \`${command}\``),
    );
  }
});

test('fails when llms.txt is stale', async () => {
  const { options, packageDir } = await generated();
  await writeFile(path.join(packageDir, 'llms.txt'), 'old text\n');
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /llms\.txt is stale/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when a public export is missing from llms.txt', async () => {
  const { options, packageDir } = await generated();
  const declarations = path.join(packageDir, 'dist', 'index.d.ts');
  await writeFile(
    declarations,
    `${await readFile(declarations, 'utf8')}export declare const farewell: string;\n`,
  );
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /does not list the export `farewell`/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when the common-mistakes block differs from docs-src/common-mistakes.md', async () => {
  const { options } = await makeRepo({ agents: agentsMd('Something else entirely.\n') });
  await generateAgentDocs({ ...options, syncBlocks: false });
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /common-mistakes block differs/.test(problem)),
    problems.join('\n'),
  );
});

test('generate rewrites a differing block, and fails when the markers are missing', async () => {
  const { options, packageDir } = await generated({ agents: agentsMd('Stale.\n') });
  assert.deepEqual(await checkAgentDocs(options), []);
  await writeFile(path.join(packageDir, 'AGENTS.md'), '# No markers\n');
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /common-mistakes markers/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when a README ts fence does not typecheck, naming the file and line', async () => {
  const { options } = await generated({ readmeText: readme(fenceOf("const count: number = 'many';")) });
  const problems = await checkAgentDocs(options);
  const failure = problems.find((problem) => /README\.md:\d+/.test(problem));
  assert.ok(failure && /TS2322/.test(failure), problems.join('\n'));
});

async function giveReactTo(packageDir) {
  await mkdir(path.join(packageDir, 'node_modules', '@types'), { recursive: true });
  await symlink(
    path.join(REACT_PACKAGE, 'node_modules', 'react'),
    path.join(packageDir, 'node_modules', 'react'),
  );
  await symlink(
    path.join(REACT_PACKAGE, 'node_modules', '@types', 'react'),
    path.join(packageDir, 'node_modules', '@types', 'react'),
  );
}

test('compiles tsx fences against the package dist types, and skips not-compiled fences', async () => {
  const goodTsx = fenceOf(
    "import { hello } from '@scope/demo';\nexport const view = <p>{hello('a')}</p>;",
    'tsx',
  );
  const skipped = fenceOf("// not-compiled: needs a bundler\nconst count: number = 'many';");
  const { options, packageDir } = await generated({ readmeText: readme(goodTsx + skipped) });
  await giveReactTo(packageDir);
  assert.deepEqual(await checkAgentDocs(options), []);
});

test('fails when a fence imports a path the package does not export', async () => {
  const fence = fenceOf("import { hello } from '@scope/demo/internal';\nhello('a');");
  const { options } = await generated({ readmeText: readme(fence) });
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /@scope\/demo\/internal is not a public entry/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when package.json files omits a shipped doc', async () => {
  const { options } = await generated({ files: ['dist', 'README.md'] });
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /"files" must list AGENTS\.md, llms\.txt/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when the README does not link the API reference by DOCS_URL', async () => {
  const { options, packageDir } = await generated();
  await writeFile(path.join(packageDir, 'README.md'), '# @scope/demo\n\nA demo package.\n');
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /must link the API reference at/.test(problem)),
    problems.join('\n'),
  );
});

const failsOn = async (readmeText, pattern) => {
  const { options } = await generated({ readmeText });
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    problems.join('\n'),
  );
};
const BAD_TS = "const count: number = 'many';";

test('fails on a bad fence written with tildes, four backticks, or indentation', async () => {
  await failsOn(readme(`~~~ts\n${BAD_TS}\n~~~\n`), /README\.md:\d+ TS2322/);
  await failsOn(readme(`\`\`\`\`ts\n${BAD_TS}\n\`\`\`\`\n`), /README\.md:\d+ TS2322/);
  await failsOn(readme(`- item\n\n   \`\`\`ts\n   ${BAD_TS}\n   \`\`\`\n`), /README\.md:\d+ TS2322/);
});

test('compiles js and jsx fences too', async () => {
  await failsOn(readme(fenceOf('const n = 1;\nn();', 'js')), /README\.md:\d+ TS2349/);
  await failsOn(readme(fenceOf('export const n = <p />;\nn();', 'jsx')), /README\.md:\d+/);
});

test('fails closed on an unclosed fence, a fence without a language, and an unknown language', async () => {
  await failsOn(readme(`\`\`\`ts\n${BAD_TS}\n`), /unclosed code fence/);
  await failsOn(readme('```\nplain\n```\n'), /needs a language/);
  await failsOn(readme(fenceOf('fn main() {}', 'rust')), /unknown fence language "rust"/);
});

test('accepts shell and data fences without compiling them', async () => {
  const { options } = await generated({
    readmeText: readme(fenceOf('npm install', 'sh') + fenceOf('{}', 'json')),
  });
  assert.deepEqual(await checkAgentDocs(options), []);
});

test('fails when the types file of an entry point is missing', async () => {
  const { options, packageDir } = await generated();
  await rm(path.join(packageDir, 'dist', 'index.d.ts'));
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /types file .*index\.d\.ts is missing/.test(problem)),
    problems.join('\n'),
  );
});

test("an export named only in another entry's prose does not count as listed", async () => {
  const { options, packageDir } = await generated();
  const declarations = path.join(packageDir, 'dist', 'index.d.ts');
  await writeFile(
    declarations,
    (await readFile(declarations, 'utf8')).replace('Says hello.', 'Says `farewell`.'),
  );
  await generateAgentDocs(options);
  await writeFile(
    declarations,
    `${await readFile(declarations, 'utf8')}export declare const farewell: string;\n`,
  );
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /does not list the export `farewell`/.test(problem)),
    problems.join('\n'),
  );
});

test('fails when a fence imports a stylesheet the package does not ship', async () => {
  const { options, packageDir } = await generated({
    readmeText: readme(fenceOf("import '@scope/demo/styles.css';")),
  });
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.exports['./styles.css'] = './dist/styles.css';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /dist\/styles\.css, which does not exist/.test(problem)),
    problems.join('\n'),
  );
});

test('type-checks a vite config fence against the stub, so a misspelt option fails', async () => {
  const good = fenceOf(
    "import { defineConfig } from 'vite';\nexport default defineConfig({ optimizeDeps: { exclude: ['a'] } });",
  );
  const bad = fenceOf(
    "import { defineConfig } from 'vite';\nexport default defineConfig({ optimizeDeps: { exlcude: ['a'] } });",
  );
  const { options } = await generated({ readmeText: readme(good) });
  assert.deepEqual(await checkAgentDocs(options), []);
  await failsOn(readme(bad), /README\.md:\d+ TS2561/);
});

test('provides isSignedIn to fences, as the quick start uses it', async () => {
  const { options } = await generated({
    readmeText: readme(fenceOf('export const ok = async (req: Request) => isSignedIn(req);')),
  });
  assert.deepEqual(await checkAgentDocs(options), []);
});

test('extractFences reads every fence with its language, first line number and code', () => {
  const fences = extractFences('text\n\n```tsx\nconst a = 1;\n```\n\n~~~bash\nls\n~~~\n');
  assert.deepEqual(fences, [
    { language: 'tsx', line: 3, code: 'const a = 1;', isClosed: true },
    { language: 'bash', line: 7, code: 'ls', isClosed: true },
  ]);
});

const QUICK_START_START = '<!-- quick-start:start -->';
const QUICK_START_END = '<!-- quick-start:end -->';
const ROUTE_SOURCE =
  "import { isSignedIn } from '../../../../lib/auth';\n/**\n * Docs.\n *\n * @example\n * use();\n */\nexport const GET = () => isSignedIn;\n";
const PAGE_SOURCE = "'use client';\nexport default function Files() {\n  return null;\n}\n";

async function addQuickStart(root, rootReadme = `# Demo\n\n${QUICK_START_START}\n${QUICK_START_END}\n`) {
  const recipes = path.join(root, 'examples', 'recipes', 'src');
  const example = path.join(root, 'examples', 'next', 'app');
  await mkdir(recipes, { recursive: true });
  await mkdir(example, { recursive: true });
  await writeFile(path.join(example, 'route.ts'), ROUTE_SOURCE);
  await writeFile(path.join(example, 'page.tsx'), PAGE_SOURCE);
  await writeFile(path.join(recipes, 'serverRoute.ts'), "export { GET } from '../../next/app/route';\n");
  await writeFile(path.join(recipes, 'clientPage.tsx'), "export { default } from '../../next/app/page';\n");
  await writeFile(path.join(root, 'README.md'), rootReadme);
}

test('generate injects the recipe sources into the root README, and the check passes', async () => {
  const { root, options } = await makeRepo();
  await addQuickStart(root);
  await generateAgentDocs(options);
  const rootReadme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.ok(rootReadme.includes('export const GET = () => isSignedIn;'));
  assert.ok(rootReadme.includes(PAGE_SOURCE.trim()));
  assert.ok(!rootReadme.includes('lib/auth'));
  assert.ok(!rootReadme.includes('Docs.'));
  assert.deepEqual(await checkAgentDocs(options), []);
});

test('fails when the root README quick start differs from the recipe source', async () => {
  const { root, options } = await makeRepo();
  await addQuickStart(root);
  await generateAgentDocs(options);
  const file = path.join(root, 'README.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('GET', 'POST'));
  const problems = await checkAgentDocs(options);
  assert.ok(
    problems.some((problem) => /README\.md: the quick start differs from examples\/recipes/.test(problem)),
  );
});

test('fails when the root README has no quick-start markers', async () => {
  const { root, options } = await makeRepo();
  await addQuickStart(root, '# Demo\n');
  const problems = await checkAgentDocs(options);
  assert.ok(problems.some((problem) => problem.includes('README.md needs the quick-start markers')));
});
