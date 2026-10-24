import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGES, readDocsUrl } from '../../../scripts/agent-docs.mjs';
import { readPages } from './check-content.mjs';
import { buildLlms, frontMatterOf } from './llms.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CORE_FIXTURE = 'apps/docs/test/fixtures/core.md';
const RECIPE_LINKS = /^- \[[^\]]+\]\(([^)]+\/docs\/recipes\/[^)]+)\)/gm;

test('llms.txt links the quick start, coding agents, every package and every recipe', async () => {
  const docsUrl = await readDocsUrl(ROOT);
  const { llmsTxt } = await buildLlms(ROOT, CORE_FIXTURE);
  assert.ok(llmsTxt.includes(`(${docsUrl}/docs/getting-started/next)`));
  assert.ok(llmsTxt.includes(`(${docsUrl}/docs/coding-agents)`));
  for (const folderName of PUBLIC_PACKAGES) {
    assert.ok(llmsTxt.includes(`(${docsUrl}/api/${folderName})`), `API link for ${folderName}`);
    assert.ok(!llmsTxt.includes(`packages/${folderName}/README.md`), `no relative README for ${folderName}`);
  }
  const recipes = (await readPages(ROOT)).filter((page) => page.url.startsWith('/docs/recipes/'));
  assert.ok(recipes.length > 0);
  const linked = [...llmsTxt.matchAll(RECIPE_LINKS)].map((match) => match[1]);
  assert.deepEqual(linked.sort(), recipes.map((page) => `${docsUrl}${page.url}`).sort());
  assert.ok(llmsTxt.includes(`${docsUrl}/llms-full.txt`));
});

test('llms-full.txt contains the text of every docs page and links the API pages', async () => {
  const docsUrl = await readDocsUrl(ROOT);
  const { llmsFullTxt } = await buildLlms(ROOT, CORE_FIXTURE);
  const pages = await readPages(ROOT);
  assert.ok(pages.length > 10);
  for (const page of pages) {
    assert.ok(llmsFullTxt.includes(frontMatterOf(page.text).body.trim()), `text of ${page.url}`);
    assert.ok(llmsFullTxt.includes(`${docsUrl}${page.url}`), `address of ${page.url}`);
  }
  for (const folderName of PUBLIC_PACKAGES) {
    assert.ok(llmsFullTxt.includes(`${docsUrl}/api/${folderName}`), `API link for ${folderName}`);
  }
});

test('llms-full.txt inlines the files that a recipe page embeds', async () => {
  const { llmsFullTxt } = await buildLlms(ROOT, CORE_FIXTURE);
  assert.ok(llmsFullTxt.includes('export function s3Store') || llmsFullTxt.includes('s3Store('));
  assert.ok(llmsFullTxt.includes('examples/recipes/src/s3Store.ts'));
});

test('llms-full.txt writes out the adapter contract', async () => {
  const { llmsFullTxt } = await buildLlms(ROOT, CORE_FIXTURE);
  for (const name of [
    'FileSystemAdapter',
    'Entry',
    'EntryKind',
    'CallOptions',
    'ChangeEvent',
    'FsErrorKind',
  ]) {
    assert.ok(llmsFullTxt.includes(`#### ${name}\n`), `section for ${name}`);
  }
  assert.ok(!llmsFullTxt.includes('](#entry'), 'no dangling same-page links');
});

test('two builds produce identical output', async () => {
  assert.deepEqual(await buildLlms(ROOT, CORE_FIXTURE), await buildLlms(ROOT, CORE_FIXTURE));
});

test('frontMatterOf splits the title and description from the body', () => {
  const parsed = frontMatterOf('---\ntitle: S3 store\ndescription: Serve a bucket.\n---\n\nBody.\n');
  assert.deepEqual(parsed, { title: 'S3 store', description: 'Serve a bucket.', body: '\nBody.\n' });
});

test('every docs page has a Markdown copy, with llms.txt as the home page and a 404 page', async () => {
  const { llmsTxt, markdownPages } = await buildLlms(ROOT, CORE_FIXTURE);
  assert.equal(markdownPages.get('index.md'), llmsTxt);
  assert.match(markdownPages.get('404.md'), /^# Page not found\n/);
  for (const page of await readPages(ROOT)) {
    const { title } = frontMatterOf(page.text);
    assert.ok(
      markdownPages.get(`${page.url.slice(1)}.md`)?.startsWith(`# ${title}\n`),
      `Markdown for ${page.url}`,
    );
  }
});
