import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveIncludePath } from '../lib/includePath.mjs';
import { checkIncludes, includeFilesOf } from './check-content.mjs';
import { embeddedFiles } from './llms.mjs';

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'include-path-'));
  for (const name of ['examples/a.ts', 'examples/.hidden/h.ts', 'examples/data.json', 'secret.ts', '.env']) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'SECRET\n');
  }
  await symlink(path.join(root, 'secret.ts'), path.join(root, 'examples', 'link.ts'));
  return root;
}

test('resolveIncludePath accepts a plain example file', async () => {
  const root = await makeRoot();
  assert.match(await resolveIncludePath(root, 'examples/a.ts'), /examples\/a\.ts$/);
});

test('resolveIncludePath refuses traversal, symlinks out, dotfiles, backslashes and other extensions', async () => {
  const root = await makeRoot();
  for (const file of [
    'examples/../secret.ts',
    'examples/./a.ts',
    '../secret.ts',
    '/etc/passwd',
    'examples/link.ts',
    'examples/.hidden/h.ts',
    'examples/data.json',
    'examples\\a.ts',
    '.env',
    'examples/missing.ts',
  ]) {
    await assert.rejects(resolveIncludePath(root, file), /refuses|Include/, file);
  }
});

test('includeFilesOf ignores commented-out and fenced tags', () => {
  const text = [
    '<Include file="examples/a.ts" />',
    '{/* <Include file="examples/b.ts" /> */}',
    '<!-- <Include file="examples/c.ts" /> -->',
    '```mdx\n<Include file="examples/d.ts" />\n```',
  ].join('\n');
  assert.deepEqual(includeFilesOf(text), ['examples/a.ts']);
});

test('embeddedFiles publishes only the live tags that pass the path rules', async () => {
  const root = await makeRoot();
  const [section, ...rest] = await embeddedFiles(
    root,
    '<Include file="examples/a.ts" />\n{/* <Include file="secret.ts" /> */}',
  );
  assert.match(section, /examples\/a\.ts/);
  assert.equal(rest.length, 0);
  await assert.rejects(embeddedFiles(root, '<Include file="secret.ts" />'), /refuses/);
  await assert.rejects(embeddedFiles(root, '<Include file="examples/link.ts" />'), /refuses/);
});

test('checkIncludes validates tags on every page, not only recipes', async () => {
  const root = await makeRoot();
  const pages = [
    { label: 'guide.mdx', url: '/docs/guide', text: '<Include file="../../.env" />' },
    { label: 'ok.mdx', url: '/docs/ok', text: '<Include file="examples/a.ts" />' },
    { label: 'hidden.mdx', url: '/docs/hidden', text: '{/* <Include file="secret.ts" /> */}' },
  ];
  const problems = checkIncludes(pages, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /guide\.mdx/);
});
