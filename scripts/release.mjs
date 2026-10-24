import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGES } from './public-packages.mjs';

const REPOSITORY_URL = 'git+https://github.com/Adityazero4/workspacekit.git';
const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function manifestProblems(folder, manifest, version) {
  const where = `packages/${folder}/package.json`;
  return [
    manifest.name !== `@workspacekit/${folder}` &&
      `${where} is named ${manifest.name}, not @workspacekit/${folder}`,
    manifest.version !== version && `${where} has version ${manifest.version}, not ${version}`,
    manifest.private === true && `${where} is private`,
    manifest.publishConfig?.access !== 'public' && `${where} needs publishConfig.access "public"`,
    manifest.publishConfig?.provenance !== true && `${where} needs publishConfig.provenance true`,
    manifest.repository?.url !== REPOSITORY_URL && `${where} needs repository.url ${REPOSITORY_URL}`,
  ].filter(Boolean);
}

const versionOfTag = (tag) => RELEASE_TAG.exec(tag ?? '')?.[1];

/**
 * Why `tag` cannot be released from these packages: the tag must be `v` plus a semver version, and every
 * package must be named `@workspacekit/<folder>`, carry exactly that version, not be private, publish with
 * public access and provenance, and name this repository (npm's trusted publishing requires
 * `repository.url` to match it).
 *
 * @example
 * releaseProblems('v0.1.0', [{ folder: 'core', manifest: { version: '0.0.0', private: true } }]);
 * // ['packages/core/package.json has version 0.0.0, not 0.1.0', 'packages/core/package.json is private', …]
 */
export function releaseProblems(tag, packages) {
  const version = versionOfTag(tag);
  if (version === undefined) return [`the tag ${tag} is not v followed by a semver version`];
  return packages.flatMap(({ folder, manifest }) => manifestProblems(folder, manifest, version));
}

/**
 * The `npm publish` arguments for one tarball: public, with provenance, and a prerelease (a version with
 * `-`) under the `next` dist-tag so it never becomes `latest`.
 *
 * @example
 * publishArguments('core.tgz', '0.1.0-rc.1');
 * // ['publish', 'core.tgz', '--access', 'public', '--provenance', '--tag', 'next']
 */
export function publishArguments(tarball, version) {
  const base = ['publish', tarball, '--access', 'public', '--provenance'];
  return version.includes('-') ? [...base, '--tag', 'next'] : base;
}

/**
 * Why these tarballs are not exactly the release: there must be one per public package, named
 * `@workspacekit/<folder>`, each at `version`, and nothing else, so `npm publish` never sees a stray or
 * renamed tarball.
 *
 * @example
 * tarballProblems([{ name: '@workspacekit/core', version: '0.1.0' }], '0.1.0');
 * // ['the tarballs lack @workspacekit/server', …]
 */
export function tarballProblems(manifests, version) {
  const expected = PUBLIC_PACKAGES.map((folder) => `@workspacekit/${folder}`);
  const names = manifests.map(({ name }) => name);
  return [
    ...expected.filter((name) => !names.includes(name)).map((name) => `the tarballs lack ${name}`),
    ...names
      .filter((name) => !expected.includes(name))
      .map((name) => `the tarball ${name} is not a public package`),
    ...names
      .filter((name, index) => names.indexOf(name) !== index)
      .map((name) => `the tarball ${name} appears twice`),
    ...manifests
      .filter((manifest) => manifest.version !== version)
      .map(({ name, version: found }) => `the tarball ${name} is at ${found}, not ${version}`),
  ];
}

function manifestOfTarball(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
}

function isPublished(name, version) {
  const viewed = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  return viewed.status === 0 && viewed.stdout.trim() === version;
}

function tokenConfig() {
  if (!process.env.NPM_TOKEN) return { flags: [], cleanup: () => undefined };
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-npmrc-'));
  const userconfig = path.join(folder, '.npmrc');
  writeFileSync(userconfig, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
  return {
    flags: ['--userconfig', userconfig],
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

function publishAll(folder, version) {
  const tarballs = readdirSync(folder)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => ({
      tarball: path.join(folder, name),
      manifest: manifestOfTarball(path.join(folder, name)),
    }));
  const problems = tarballProblems(
    tarballs.map(({ manifest }) => manifest),
    version,
  );
  if (problems.length > 0) throw new Error(`release: refusing to publish: ${problems.join('; ')}`);
  const token = tokenConfig();
  try {
    for (const { tarball, manifest } of tarballs) {
      if (isPublished(manifest.name, manifest.version)) {
        process.stdout.write(`${manifest.name}@${manifest.version} is already published, skipped\n`);
        continue;
      }
      execFileSync('npm', [...publishArguments(tarball, manifest.version), ...token.flags], {
        stdio: 'inherit',
      });
    }
  } finally {
    token.cleanup();
  }
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const [command, folder] = process.argv.slice(2);
  if (command === 'check') {
    const packages = PUBLIC_PACKAGES.map((name) => ({
      folder: name,
      manifest: JSON.parse(
        readFileSync(path.join(REPOSITORY_ROOT, 'packages', name, 'package.json'), 'utf8'),
      ),
    }));
    const problems = releaseProblems(process.env.RELEASE_TAG, packages);
    for (const problem of problems) console.error(`release: ${problem}`);
    if (problems.length > 0) process.exit(1);
  } else if (command === 'publish' && folder && versionOfTag(process.env.RELEASE_TAG)) {
    publishAll(path.resolve(folder), versionOfTag(process.env.RELEASE_TAG));
  } else {
    console.error('usage: RELEASE_TAG=v1.2.3 node scripts/release.mjs check | publish <folder>');
    process.exit(2);
  }
}
