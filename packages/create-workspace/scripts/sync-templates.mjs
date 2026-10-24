import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_SOURCES = { next: 'next-agent-workspace', vite: 'vite-memory' };
const DROPPED_TOP_LEVEL = new Set([
  'test',
  'tsconfig.monorepo.json',
  'vitest.browser.config.ts',
  'playwright.config.ts',
]);
const BUILD_OUTPUT_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  'test-results',
  'playwright-report',
]);
const TEST_ONLY_DEV_DEPENDENCIES = new Set([
  '@playwright/test',
  'playwright',
  '@vitest/browser-playwright',
  'axe-core',
]);
const DROPPED_SCRIPTS = new Set(['test', 'test:e2e']);
const MONOREPO_TSCONFIG = ' -p tsconfig.monorepo.json';
const GITIGNORE_NAME = '.gitignore';
const PACKED_GITIGNORE_NAME = '_gitignore';
const STARTER_ONLY_SCRIPTS = { next: { build: 'next build', start: 'next start' } };
const MONOREPO_ONLY = /<!-- monorepo-only -->[\s\S]*?<!-- \/monorepo-only -->\n?/g;
const STARTER_ONLY = /<!-- starter-only\n([\s\S]*?)-->\n?/g;

/**
 * The repository root that holds `packages/` and `examples/`.
 *
 * @example
 * const root = repositoryRoot();
 */
export function repositoryRoot() {
  return path.resolve(PACKAGE_ROOT, '..', '..');
}

function isShippedPath(relativePath) {
  const segments = relativePath.split('/');
  if (DROPPED_TOP_LEVEL.has(segments[0])) return false;
  if (segments.some((segment) => BUILD_OUTPUT_DIRECTORIES.has(segment))) return false;
  return !relativePath.endsWith('.tsbuildinfo');
}

async function listTrackedFiles(directory) {
  try {
    const { stdout } = await runFile('git', ['ls-files', '-z', '--', '.'], { cwd: directory });
    return stdout.split('\0').filter(Boolean);
  } catch (error) {
    throw new Error(
      `Cannot list the files Git tracks in ${directory}: ${error.message}\n` +
        'Run this from a Git checkout with git installed; untracked files are never copied into a template.',
      { cause: error },
    );
  }
}

/**
 * Lists the files of one example that belong in a starter, relative to the example.
 *
 * Uses `git ls-files` so untracked files (build output, `.env`) can never leak in, and throws when
 * Git cannot list them.
 *
 * @example
 * const files = await collectTemplateFiles('examples/vite-memory');
 */
export async function collectTemplateFiles(exampleDirectory) {
  return (await listTrackedFiles(exampleDirectory)).filter(isShippedPath);
}

function rewritePackageJson(manifest, typescriptVersion, template) {
  const scripts = {
    ...Object.fromEntries(
      Object.entries(manifest.scripts ?? {})
        .filter(([name]) => !DROPPED_SCRIPTS.has(name))
        .map(([name, command]) => [
          name,
          name === 'typecheck' ? command.replace(MONOREPO_TSCONFIG, '') : command,
        ]),
    ),
    ...STARTER_ONLY_SCRIPTS[template],
  };
  const devDependencies = Object.entries({ ...manifest.devDependencies, typescript: typescriptVersion })
    .filter(([name]) => !TEST_ONLY_DEV_DEPENDENCIES.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  return { ...manifest, scripts, devDependencies: Object.fromEntries(devDependencies) };
}

function rewriteReadme(markdown) {
  return markdown.replace(MONOREPO_ONLY, '').replace(STARTER_ONLY, '$1');
}

async function transformedContent(relativePath, source, typescriptVersion, template) {
  if (relativePath === 'package.json') {
    const manifest = JSON.parse(source.toString('utf8'));
    return `${JSON.stringify(rewritePackageJson(manifest, typescriptVersion, template), null, 2)}\n`;
  }
  if (relativePath === 'README.md') return rewriteReadme(source.toString('utf8'));
  return source;
}

function packedName(relativePath) {
  return path.basename(relativePath) === GITIGNORE_NAME
    ? path.join(path.dirname(relativePath), PACKED_GITIGNORE_NAME)
    : relativePath;
}

async function writeTemplate(exampleDirectory, templateDirectory, typescriptVersion, template) {
  for (const relativePath of await collectTemplateFiles(exampleDirectory)) {
    const source = await readFile(path.join(exampleDirectory, relativePath)).catch(() => null);
    if (source === null) continue;
    const target = path.join(templateDirectory, packedName(relativePath));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await transformedContent(relativePath, source, typescriptVersion, template));
  }
}

async function collectPackageVersions(root) {
  const versions = {};
  for (const folder of await readdir(path.join(root, 'packages'))) {
    const manifest = await readFile(path.join(root, 'packages', folder, 'package.json'), 'utf8').catch(
      () => null,
    );
    if (manifest === null) continue;
    const { name, version, private: isPrivate } = JSON.parse(manifest);
    if (name?.startsWith('@workspacekit/')) versions[name] = { version, private: isPrivate === true };
  }
  return Object.fromEntries(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Writes `next/`, `vite/` and `versions.json` into `outputDirectory` from the examples.
 *
 * @example
 * await buildTemplates(repositoryRoot(), 'packages/create-workspace/templates');
 */
export async function buildTemplates(root, outputDirectory) {
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const typescriptVersion = rootManifest.devDependencies.typescript;
  await rm(outputDirectory, { recursive: true, force: true });
  for (const [template, example] of Object.entries(TEMPLATE_SOURCES)) {
    await writeTemplate(
      path.join(root, 'examples', example),
      path.join(outputDirectory, template),
      typescriptVersion,
      template,
    );
  }
  const versions = await collectPackageVersions(root);
  await writeFile(path.join(outputDirectory, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildTemplates(repositoryRoot(), path.join(PACKAGE_ROOT, 'templates'));
}
