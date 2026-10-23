import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildTemplates, collectTemplateFiles, repositoryRoot } from '../scripts/sync-templates.mjs';

let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'sync-templates-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeAll(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(directory, relative)));
    else found.push(relative);
  }
  return found;
}

describe('collectTemplateFiles', () => {
  it('lists only tracked files, so an untracked .env, dist/ or tsbuildinfo never reaches a template', async () => {
    const example = path.join(sandbox, 'tracked');
    await writeAll(example, {
      'package.json': '{}',
      'src/main.tsx': '',
      'test/app.e2e.ts': '',
      'tsconfig.monorepo.json': '{}',
      '.env': 'SECRET=1',
      'dist/index.js': '',
      'tsconfig.tsbuildinfo': '',
    });
    execFileSync('git', ['init', '-q'], { cwd: example });
    execFileSync(
      'git',
      ['add', 'package.json', 'src/main.tsx', 'test/app.e2e.ts', 'tsconfig.monorepo.json'],
      {
        cwd: example,
      },
    );
    assert.deepEqual((await collectTemplateFiles(example)).sort(), ['package.json', 'src/main.tsx']);
  });

  it('drops a tracked dist/ or tsbuildinfo too', async () => {
    const example = path.join(sandbox, 'tracked-output');
    await writeAll(example, { 'package.json': '{}', 'dist/index.js': '', 'tsconfig.tsbuildinfo': '' });
    execFileSync('git', ['init', '-q'], { cwd: example });
    execFileSync('git', ['add', '-A', '-f'], { cwd: example });
    assert.deepEqual(await collectTemplateFiles(example), ['package.json']);
  });

  it('throws a clear error instead of walking the folder when Git cannot list it', async () => {
    const example = path.join(sandbox, 'not-git');
    await writeAll(example, { 'package.json': '{}', '.env': 'SECRET=1' });
    await assert.rejects(collectTemplateFiles(example), /Cannot list the files Git tracks/);
  });
});

describe('buildTemplates', () => {
  it('copies no build output from the real examples, which hold some', async () => {
    const output = path.join(sandbox, 'built');
    await buildTemplates(repositoryRoot(), output);
    const files = await listFiles(output);
    assert.ok(files.includes('vite/package.json'));
    assert.deepEqual(
      files.filter((file) => /(^|\/)dist\/|\.tsbuildinfo$|(^|\/)\.env$/.test(file)),
      [],
    );
  });
});
