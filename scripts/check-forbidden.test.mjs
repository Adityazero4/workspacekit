import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './check-forbidden.mjs';

const SCRIPT = fileURLToPath(new URL('./check-forbidden.mjs', import.meta.url));
const bad = 'acme-secret';

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'forbidden-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  return root;
}

// Runs a copy of the CLI inside `root/scripts/`, so `root` is the tree it scans.
async function runCli(root, env = {}) {
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  const script = path.join(root, 'scripts', 'check-forbidden.mjs');
  await copyFile(SCRIPT, script);
  const childEnv = { ...process.env, ...env };
  if (!('FORBIDDEN_PATTERNS' in env)) delete childEnv.FORBIDDEN_PATTERNS;
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { env: childEnv }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

test('flags a forbidden string and ignores skipped dirs', async () => {
  const body = `ok\nhello ${bad.toUpperCase()}\n`;
  const tmp = await fixture({
    'a.ts': body,
    'internal/x.md': body,
    'node_modules/y.js': body,
    'dist/z.js': body,
    '.git/c': body,
    '.superpowers/s.md': body,
    'bin.dat': Buffer.from([0, 1, 2, ...Buffer.from(body)]),
  });
  const hits = await scan(tmp, [bad]);
  assert.deepEqual(hits.map((h) => [path.basename(h.file), h.line, h.pattern]), [['a.ts', 2, bad]]);
});

test('clean tree returns no hits', async () => {
  const tmp = await fixture({ 'a.ts': 'export const x = 1;\n' });
  assert.deepEqual(await scan(tmp, [bad]), []);
});

test('CLI exits 2 when no pattern list is available', async () => {
  const tmp = await fixture({ 'a.ts': `${bad}\n` });
  const r = await runCli(tmp);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /forbidden-strings: no pattern list \(set FORBIDDEN_PATTERNS or create internal\/forbidden-patterns\.txt\)/);
});

test('CLI uses the FORBIDDEN_PATTERNS env list, prints file:line pattern and exits 1 on a hit', async () => {
  const tmp = await fixture({ 'src/a.ts': `ok\nx ${bad.toUpperCase()} y\n` });
  const r = await runCli(tmp, { FORBIDDEN_PATTERNS: ` other , ${bad.toUpperCase()} ` });
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `${path.join('src', 'a.ts')}:2 ${bad}`);
});

test('CLI reads internal/forbidden-patterns.txt (comments ignored) and exits 0 on a clean tree', async () => {
  const tmp = await fixture({
    'internal/forbidden-patterns.txt': `# comment\n${bad}\n\n`,
    'a.ts': 'export const x = 1;\n',
  });
  assert.equal((await runCli(tmp)).code, 0);
  await writeFile(path.join(tmp, 'b.ts'), `${bad}\n`);
  const r = await runCli(tmp);
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `b.ts:1 ${bad}`);
});
