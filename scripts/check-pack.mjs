import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGES } from './public-packages.mjs';

const ALLOWED =
  /^package\/(package\.json|README\.md|AGENTS\.md|llms\.txt|LICENSE|NOTICE|dist\/.+|templates\/.+)$/;
const REQUIRED = ['README.md', 'AGENTS.md', 'llms.txt', 'LICENSE', 'NOTICE'];
const LOCAL_RANGE = /^(workspace|file|link):/;
const SOURCE_MAP_REFERENCE = /sourceMappingURL=(\S+)/g;
const MACHINE_HOME = /\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users\\{1,2}/;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_URL = 'git+https://github.com/Adityazero4/workspacekit.git';
const HOMEPAGE = 'https://docs-ashy-alpha.vercel.app';
const BUGS = 'https://github.com/Adityazero4/workspacekit/issues';

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];
}

function linkProblems(manifest) {
  const folder = `packages/${String(manifest.name).split('/').pop()}`;
  const repository = manifest.repository ?? {};
  const repositoryMatches =
    repository.type === 'git' && repository.url === REPOSITORY_URL && repository.directory === folder;
  return [
    ...(repositoryMatches
      ? []
      : [
          `package.json repository must be { type: 'git', url: '${REPOSITORY_URL}', directory: '${folder}' }`,
        ]),
    ...(manifest.homepage === HOMEPAGE ? [] : [`package.json homepage must be ${HOMEPAGE}`]),
    ...(manifest.bugs === BUGS ? [] : [`package.json bugs must be ${BUGS}`]),
  ];
}

function manifestProblems(manifest, files) {
  const ranges = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
    (field) => Object.entries(manifest[field] ?? {}),
  );
  const local = ranges
    .filter(([, range]) => LOCAL_RANGE.test(range))
    .map(
      ([name, range]) =>
        `package.json has a local range for ${name}: ${range}; pnpm should rewrite it on pack`,
    );
  const targets = [...exportTargets(manifest.exports), ...exportTargets(manifest.bin)]
    .filter((target) => target.startsWith('./') && !target.includes('*'))
    .filter((target) => !files.has(`package/${target.slice(2)}`))
    .map((target) => `exports target ${target} is missing from the tarball`);
  return [...local, ...targets, ...linkProblems(manifest)];
}

function distProblems(files, repositoryRoot) {
  return [...files].flatMap(([name, text]) => {
    if (!name.startsWith('package/dist/')) return [];
    const machinePath = MACHINE_HOME.test(text) || text.includes(repositoryRoot);
    const home = machinePath ? [`${name} contains a machine path`] : [];
    const maps = [...text.matchAll(SOURCE_MAP_REFERENCE)]
      .map((match) => match[1])
      .filter((url) => !url.startsWith('data:'))
      .filter(
        (url) =>
          path.isAbsolute(url) ||
          /^[a-z]+:/.test(url) ||
          path.posix.join(path.posix.dirname(name), url).startsWith('..') ||
          !path.posix.join(path.posix.dirname(name), url).startsWith('package/'),
      )
      .map((url) => `${name} sourceMappingURL points outside the package: ${url}`);
    return [...home, ...maps];
  });
}

/**
 * Everything wrong with a packed tarball, given its files as a map of `package/...` path to text: files
 * outside the allowed set, machine paths in `dist` (a home folder or `repositoryRoot`, which defaults to
 * this checkout), local dependency ranges, `exports` targets that were not packed, missing docs or legal
 * files, and a `repository`, `homepage` or `bugs` field that does not point at this project.
 *
 * @example
 * const problems = packProblems(new Map([['package/package.json', '{}']]));
 */
export function packProblems(files, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  const unexpected = [...files.keys()]
    .filter((name) => !ALLOWED.test(name))
    .map((name) => `unexpected file ${name}`);
  const missing = REQUIRED.filter((name) => !files.has(`package/${name}`)).map(
    (name) => `missing package/${name}`,
  );
  const manifestText = files.get('package/package.json');
  const manifest = manifestText ? manifestProblems(JSON.parse(manifestText), files) : [];
  return [...unexpected, ...missing, ...manifest, ...distProblems(files, repositoryRoot)];
}

function readTree(dir, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return readTree(full, base);
    return [[path.relative(base, full).split(path.sep).join('/'), readFileSync(full, 'utf8')]];
  });
}

function packFolder(root, folder, scratch) {
  const out = path.join(scratch, folder);
  execFileSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: path.join(root, 'packages', folder),
    stdio: 'pipe',
  });
  const tarball = path.join(
    out,
    readdirSync(out).find((name) => name.endsWith('.tgz')),
  );
  const unpacked = path.join(out, 'unpacked');
  execFileSync('mkdir', ['-p', unpacked]);
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
  return { files: new Map(readTree(unpacked)), bytes: statSync(tarball).size, tarball };
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const root = REPOSITORY_ROOT;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'check-pack-'));
  const outIndex = process.argv.indexOf('--out');
  const keepTarballsIn = outIndex === -1 ? undefined : path.resolve(process.argv[outIndex + 1] ?? '');
  if (keepTarballsIn) mkdirSync(keepTarballsIn, { recursive: true });
  let failed = false;
  for (const folder of PUBLIC_PACKAGES) {
    const { files, bytes, tarball } = packFolder(root, folder, scratch);
    if (keepTarballsIn) copyFileSync(tarball, path.join(keepTarballsIn, path.basename(tarball)));
    process.stdout.write(`${folder}: ${(bytes / 1024).toFixed(1)} KiB, ${files.size} files\n`);
    for (const problem of packProblems(files)) {
      console.error(`  ${folder}: ${problem}`);
      failed = true;
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  if (failed) process.exit(1);
}
