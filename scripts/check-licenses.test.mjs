import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_LIST,
  dependenciesOf,
  licenseViolations,
  noticeFileText,
  noticesMarkdown,
} from './check-licenses.mjs';

const SCRIPT = fileURLToPath(new URL('./check-licenses.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/licenses/${name}.json`, import.meta.url));
const reportOf = async (name) => JSON.parse(await readFile(fixture(name), 'utf8'));

// Runs a copy of the CLI inside `root/scripts/`, so it reads and writes `root/THIRD_PARTY_NOTICES.md` and `root/NOTICE`.
async function runCli(args) {
  const root = await mkdtemp(path.join(tmpdir(), 'licenses-'));
  await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'check-licenses.mjs');
  await copyFile(SCRIPT, script);
  const run = (extraArgs) =>
    new Promise((resolve) => {
      execFile(process.execPath, [script, ...extraArgs], (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
      );
    });
  return { root, run, first: await run(args) };
}

test('flattens the pnpm report into one dependency per version, sorted by code point', async () => {
  const dependencies = dependenciesOf(await reportOf('permissive'));
  assert.deepEqual(
    dependencies.map(({ name, version, license }) => `${name}@${version} ${license}`),
    [
      'Zebra-upper@1.0.0 BSD-3-Clause',
      'jszip@3.10.1 (MIT OR GPL-3.0-or-later)',
      'left-pad@1.3.0 MIT',
      'mtx-decompressor@1.0.0 MPL-2.0',
      'public-domain-thing@1.0.0 Unlicense',
      'public-domain-thing@2.0.0 Unlicense',
    ],
  );
});

test('flags GPL, AGPL and LGPL in any spelling, UNLICENSED and unreadable licences, and nothing permissive', async () => {
  const violations = licenseViolations(dependenciesOf(await reportOf('copyleft')));
  assert.deepEqual(
    violations.map(({ name, license }) => `${name}: ${license}`),
    [
      '@kandiforge/pptx-renderer: UNLICENSED',
      'agpl-v3-spelling: AGPLv3',
      'gnu-long-name: GNU General Public License v3',
      'gpl-3-spelling: GPL3',
      'gpl-v2-spelling: GPLv2',
      'gpl-v3-spelling: GPLv3',
      'hyperformula: GPL-3.0-only',
      'jszip: GPL-3.0-or-later',
      'lesser-lib: LGPL-2.1',
      'lgpl-v3-spelling: LGPLv3',
      'no-licence-field: Unknown',
    ],
  );
});

test('the allow-list passes jszip (taken as MIT) and mtx-decompressor', async () => {
  const dependencies = dependenciesOf(await reportOf('permissive'));
  assert.deepEqual(licenseViolations(dependencies), []);
  assert.deepEqual(
    licenseViolations(dependencies, {}).map(({ name }) => name),
    ['jszip'],
  );
  assert.deepEqual(Object.keys(ALLOW_LIST).sort(), ['dompurify', 'jszip', 'mtx-decompressor']);
  for (const { license, take, reason } of Object.values(ALLOW_LIST)) assert.ok(license && take && reason);
});

test('the notices name each dependency with the licence it is used under', async () => {
  const notices = noticesMarkdown(dependenciesOf(await reportOf('permissive')));
  assert.match(notices, /^\| jszip \| 3\.10\.1 \| MIT \| https:\/\/github\.com\/Stuk\/jszip#readme \|$/m);
  assert.match(notices, /^\| mtx-decompressor \| 1\.0\.0 \| MPL-2\.0 \| {2}\|$/m);
  assert.match(notices, /^- jszip \(\(MIT OR GPL-3\.0-or-later\)\): used under MIT; /m);
});

test('the CLI exits 1 on a GPL dependency and says how to fix it', async () => {
  const { first } = await runCli(['--report', fixture('copyleft')]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /hyperformula@3\.5\.0: GPL-3\.0-only/);
  assert.match(first.stderr, /ALLOW_LIST/);
  assert.match(
    first.stderr,
    /jszip@1\.0\.0: licence is now "GPL-3\.0-or-later", but "\(MIT OR GPL-3\.0-or-later\)"/,
  );
});

test('the CLI writes the notices with --write, then passes until they go stale', async () => {
  const { root, run, first } = await runCli(['--report', fixture('permissive')]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /--write/);

  const written = await run(['--report', fixture('permissive'), '--write']);
  assert.equal(written.code, 0, written.stderr);
  const notices = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /left-pad/);
  assert.equal((await run(['--report', fixture('permissive')])).code, 0);

  await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices.replace('left-pad', 'right-pad'));
  assert.equal((await run(['--report', fixture('permissive')])).code, 1);
});

test('NOTICE names only the Apache-2.0 dependencies, counting a dual licence taken as Apache-2.0', async () => {
  const text = noticeFileText(dependenciesOf(await reportOf('apache')));
  assert.match(text, /^- @scope\/engine 2\.1\.0 \(https:\/\/example\.invalid\/engine\)$/m);
  assert.match(text, /^- dompurify 3\.4\.17$/m);
  assert.doesNotMatch(text, /left-pad/);
  assert.match(text, /Apache License, Version 2\.0/);
});

test('the CLI writes NOTICE with --write and fails when NOTICE is stale or missing', async () => {
  const report = ['--report', fixture('apache')];
  const { root, run, first } = await runCli(report);
  assert.equal(first.code, 1);

  assert.equal((await run([...report, '--write'])).code, 0);
  const notice = await readFile(path.join(root, 'NOTICE'), 'utf8');
  assert.match(notice, /@scope\/engine/);
  assert.equal((await run(report)).code, 0);

  await writeFile(path.join(root, 'NOTICE'), notice.replace('@scope/engine', '@scope/other'));
  const stale = await run(report);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /NOTICE is out of date/);

  await rm(path.join(root, 'NOTICE'));
  assert.equal((await run(report)).code, 1);
});

test("NOTICE carries each Apache-2.0 dependency's own NOTICE file verbatim, under its entry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dependency-'));
  const upstreamNotice = 'Apache ECharts\nCopyright 2017-2025 The Apache Software Foundation\n';
  await writeFile(path.join(directory, 'NOTICE'), upstreamNotice);
  const report = {
    'Apache-2.0': [{ name: 'echarts', versions: ['6.1.0'], paths: [directory], license: 'Apache-2.0' }],
  };
  const text = noticeFileText(dependenciesOf(report));
  assert.ok(text.includes(`- echarts 6.1.0\n\n${upstreamNotice}`), text);
});

test('NOTICE and THIRD_PARTY_NOTICES cover only the published scope, while the gate covers every tree', async () => {
  const entry = (name, license) => ({ [license]: [{ name, versions: ['1.0.0'], paths: [], license }] });
  const directory = await mkdtemp(path.join(tmpdir(), 'reports-'));
  const published = { ...entry('shipped-engine', 'Apache-2.0') };
  const everything = { ...published, ...entry('example-only-tool', 'Apache-2.0') };
  const publishedFile = path.join(directory, 'published.json');
  const everythingFile = path.join(directory, 'everything.json');
  await writeFile(publishedFile, JSON.stringify(published));
  await writeFile(everythingFile, JSON.stringify(everything));
  const args = ['--report', everythingFile, '--published-report', publishedFile];

  const { root, run } = await runCli(args);
  assert.equal((await run([...args, '--write'])).code, 0);
  for (const file of ['NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.match(text, /shipped-engine/);
    assert.doesNotMatch(text, /example-only-tool/);
  }
  assert.equal((await run(args)).code, 0);

  const copyleftExample = { ...everything, ...entry('example-only-gpl', 'GPL-3.0-only') };
  await writeFile(everythingFile, JSON.stringify(copyleftExample));
  const gated = await run(args);
  assert.equal(gated.code, 1);
  assert.match(gated.stderr, /example-only-gpl@1\.0\.0: GPL-3\.0-only/);
});
