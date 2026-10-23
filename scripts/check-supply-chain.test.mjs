import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  codeownersProblems,
  collectProblems,
  effectiveProblems,
  effectiveSettings,
  importerDifferences,
  exceptionProblems,
  lockfileInventory,
  lockfileShapeProblems,
  manifestFieldProblems,
  nonRegistryResolutions,
  placeholderOwnerProblems,
  pnpmfileProblems,
  settingProblems,
  unexpectedWorkspaceKeys,
  unpinnedDependencies,
  workflowProblems,
  workspacePackages,
  workspaceSettings,
} from './check-supply-chain.mjs';

const GOOD_SETTINGS = {
  minimumReleaseAge: 10080,
  trustPolicy: 'no-downgrade',
  blockExoticSubdeps: true,
  strictDepBuilds: true,
  allowBuilds: {},
  saveExact: true,
  minimumReleaseAgeExclude: ['numfmt@4.1.0'],
  trustPolicyExclude: ['semver@6.3.1'],
};
const NPM = 'https://registry.npmjs.org/';
const GOOD_EFFECTIVE = {
  status: 'ok',
  settings: { ...GOOD_SETTINGS, registry: NPM, '@jsr:registry': 'https://npm.jsr.io/' },
};
const AGE = { spec: 'numfmt@4.1.0', kind: 'release-age', reason: 'reviewed', expires: '2026-10-27' };
const TRUST = { spec: 'semver@6.3.1', kind: 'trust', reason: 'verified legitimate' };
const LOCKED = new Set(['numfmt@4.1.0', 'semver@6.3.1']);
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const settings = (changes = {}) => ({ ...GOOD_SETTINGS, ...changes });
const effectiveWith = (changes) => ({ status: 'ok', settings: { ...GOOD_EFFECTIVE.settings, ...changes } });
const exceptions = (entries, changes, today = '2026-10-23') =>
  exceptionProblems(entries, settings(changes), today, LOCKED);

test('accepts exact versions, workspace links and peer ranges', () => {
  const json = {
    dependencies: { a: '1.2.3', b: '1.0.0-rc.1', core: 'workspace:*' },
    devDependencies: { c: '2.0.0+build.5' },
    peerDependencies: { react: '^19.0.0' },
  };
  assert.deepEqual(unpinnedDependencies([{ file: 'package.json', json }]), []);
});

test('flags ranges, tags and aliases in every non-peer section', () => {
  const json = {
    dependencies: { a: '^1.2.3' },
    devDependencies: { b: '~1.0.0', c: 'latest', d: 'npm:x@1.0.0' },
    optionalDependencies: { e: '>=1' },
  };
  assert.deepEqual(unpinnedDependencies([{ file: 'p/package.json', json }]), [
    'p/package.json: dependencies.a is "^1.2.3", not an exact version',
    'p/package.json: devDependencies.b is "~1.0.0", not an exact version',
    'p/package.json: devDependencies.c is "latest", not an exact version',
    'p/package.json: devDependencies.d is "npm:x@1.0.0", not an exact version',
    'p/package.json: optionalDependencies.e is ">=1", not an exact version',
  ]);
});

test('flags overrides, resolutions and a pnpm field in a package.json', () => {
  const json = { overrides: {}, resolutions: {}, pnpm: {} };
  assert.deepEqual(manifestFieldProblems([{ file: 'package.json', json }]), [
    'package.json: overrides changes what is installed; remove it',
    'package.json: resolutions changes what is installed; remove it',
    'package.json: pnpm changes what is installed; remove it',
  ]);
});

const lockWith = (...entries) => `lockfileVersion: '9.0'\npackages:\n${entries.join('\n')}\n`;

test('accepts sha512 integrity-only resolutions, in flow or block form', () => {
  const lock = lockWith(
    `  ok@1.0.0:\n    resolution: {integrity: ${INTEGRITY}}`,
    `  '@s/ok@1.0.0':\n    resolution:\n      integrity: ${INTEGRITY}`,
  );
  assert.deepEqual(nonRegistryResolutions(lock), []);
});

test('flags a tarball resolution, even over registry.npmjs.org', () => {
  const lock = lockWith(
    `  evil@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, tarball: https://evil.example/t.tgz}`,
    `  other@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, tarball: https://registry.npmjs.org/o.tgz}`,
  );
  assert.deepEqual(nonRegistryResolutions(lock), [
    'pnpm-lock.yaml: evil@1.0.0 has resolution fields other than integrity: tarball',
    'pnpm-lock.yaml: other@1.0.0 has resolution fields other than integrity: tarball',
  ]);
});

test('flags a git resolution', () => {
  const lock = lockWith(
    '  gitdep@1.0.0:\n    resolution: {type: git, repo: https://github.com/x/y.git, commit: abc}',
  );
  assert.deepEqual(nonRegistryResolutions(lock), [
    'pnpm-lock.yaml: gitdep@1.0.0 has resolution fields other than integrity: type, repo, commit',
  ]);
});

test('flags a multi-line resolution that carries a tarball or a directory', () => {
  const lock = lockWith(
    `  a@1.0.0:\n    resolution:\n      integrity: ${INTEGRITY}\n      tarball: https://evil.example/a.tgz`,
    '  b@1.0.0:\n    resolution:\n      directory: ../b\n      type: directory',
  );
  assert.deepEqual(nonRegistryResolutions(lock), [
    'pnpm-lock.yaml: a@1.0.0 has resolution fields other than integrity: tarball',
    'pnpm-lock.yaml: b@1.0.0 has resolution fields other than integrity: directory, type',
  ]);
});

test('flags an entry with no resolution, a weak integrity or an unrecognised shape', () => {
  const lock = lockWith(
    '  a@1.0.0:\n    engines: {node: ">=1"}',
    '  b@1.0.0:\n    resolution: {}',
    '  c@1.0.0:\n    resolution: https://evil.example/c.tgz',
    '  d@1.0.0: https://evil.example/d.tgz',
    '  e@1.0.0:\n    resolution: {integrity: sha1-abc}',
    '  f@1.0.0:\n    resolution: {integrity: not-a-hash}',
  );
  assert.deepEqual(nonRegistryResolutions(lock), [
    'pnpm-lock.yaml: a@1.0.0 has no readable resolution',
    'pnpm-lock.yaml: b@1.0.0 has no sha512 resolution integrity',
    'pnpm-lock.yaml: c@1.0.0 has no readable resolution',
    'pnpm-lock.yaml: d@1.0.0 has no readable resolution',
    'pnpm-lock.yaml: e@1.0.0 has no sha512 resolution integrity',
    'pnpm-lock.yaml: f@1.0.0 has no sha512 resolution integrity',
  ]);
});

test('flags a lockfile without a packages section or that does not parse', () => {
  assert.deepEqual(nonRegistryResolutions("lockfileVersion: '9.0'\n"), [
    'pnpm-lock.yaml has no packages section this check can read',
  ]);
  assert.match(
    nonRegistryResolutions('packages: [unclosed\n')[0],
    /^pnpm-lock\.yaml does not parse as YAML: /,
  );
});

test('flags lockfile keys that change what is installed, odd importer versions and orphan snapshots', () => {
  const lock = [
    'overrides: {a: 1.0.0}',
    'pnpmfileChecksum: sha256-x',
    'importers:',
    '  .:',
    '    dependencies:',
    '      ok: {specifier: 1.0.0, version: 1.0.0(peer@2.0.0)}',
    '      local: {specifier: workspace:*, version: link:../core}',
    '      bad: {specifier: 1.0.0, version: https://evil.example/bad.tgz}',
    'packages:',
    `  ok@1.0.0: {resolution: {integrity: ${INTEGRITY}}}`,
    'snapshots:',
    '  ok@1.0.0(peer@2.0.0): {}',
    '  ghost@1.0.0: {}',
    '',
  ].join('\n');
  assert.deepEqual(lockfileShapeProblems(lock), [
    'pnpm-lock.yaml has overrides, which changes what is installed; remove it',
    'pnpm-lock.yaml has pnpmfileChecksum, which changes what is installed; remove it',
    'pnpm-lock.yaml: importers . dependencies bad resolves to "https://evil.example/bad.tgz", not a registry version or a workspace link',
    'pnpm-lock.yaml: snapshot ghost@1.0.0 has no packages entry',
  ]);
});

test('lists the lockfile packages and the directories of its importers', () => {
  const inventory = lockfileInventory('importers:\n  .: {}\n  packages/a: {}\npackages:\n  b@1.0.0: {}\n');
  assert.deepEqual([...inventory.specs], ['b@1.0.0']);
  assert.deepEqual(inventory.importers, ['.', 'packages/a']);
});

const listing = (parents) => (parent) => parents[parent] ?? [];

test('finds the workspace packages on disk from the validated globs', () => {
  const found = workspacePackages(
    ['packages/*', 'tools/cli'],
    listing({ packages: ['b', 'a'] }),
    (dir) => dir === 'tools/cli',
  );
  assert.deepEqual(found, { dirs: ['.', 'packages/a', 'packages/b', 'tools/cli'], problems: [] });
});

test('rejects globs it does not understand and a missing packages list', () => {
  const found = workspacePackages(['!packages/skip', '../outside/*', 'a/**', 7], listing({}), () => false);
  assert.deepEqual(found.problems, [
    'pnpm-workspace.yaml: packages entry "!packages/skip" is not a plain directory or a dir/* pattern',
    'pnpm-workspace.yaml: packages entry "../outside/*" is not a plain directory or a dir/* pattern',
    'pnpm-workspace.yaml: packages entry "a/**" is not a plain directory or a dir/* pattern',
    'pnpm-workspace.yaml: packages entry 7 is not a plain directory or a dir/* pattern',
  ]);
  assert.deepEqual(workspacePackages(undefined, listing({}), () => false).problems, [
    'pnpm-workspace.yaml: packages must list the workspace package directories',
  ]);
});

test('reports workspace packages and lockfile importers that do not match, in both directions', () => {
  assert.deepEqual(importerDifferences(['.', 'packages/a'], ['.', 'packages/a']), []);
  assert.deepEqual(
    importerDifferences(['.', 'packages/a', 'packages/b'], ['.', 'packages/a', 'packages/ghost']),
    [
      'packages/b is a workspace package but pnpm-lock.yaml has no importer for it',
      'pnpm-lock.yaml has an importer for packages/ghost, which is not a workspace package',
    ],
  );
});

test('accepts the full settings and names each missing one', () => {
  assert.deepEqual(settingProblems(settings()), []);
  const keys = ['trustPolicy', 'blockExoticSubdeps', 'strictDepBuilds', 'allowBuilds', 'saveExact'];
  for (const key of keys) {
    assert.deepEqual(settingProblems(settings({ [key]: undefined })), [
      `pnpm-workspace.yaml: ${key} is missing or weakened`,
    ]);
  }
  assert.deepEqual(settingProblems(settings({ minimumReleaseAge: undefined })), [
    'pnpm-workspace.yaml: minimumReleaseAge must be a number of at least 10080 (7 days)',
  ]);
});

test('flags a populated allow-list, in object or list form', () => {
  const problem = 'pnpm-workspace.yaml: allowBuilds is missing or weakened';
  assert.deepEqual(settingProblems(settings({ allowBuilds: { esbuild: true } })), [problem]);
  assert.deepEqual(settingProblems(settings({ allowBuilds: ['esbuild'] })), [problem]);
  assert.deepEqual(settingProblems(settings({ allowBuilds: { esbuild: 'set this to true or false' } })), [
    problem,
  ]);
});

test('accepts explicit refusals in the allow-list', () => {
  assert.deepEqual(settingProblems(settings({ allowBuilds: { esbuild: false } })), []);
});

test('flags a release age below seven days or not a number', () => {
  const problem = 'pnpm-workspace.yaml: minimumReleaseAge must be a number of at least 10080 (7 days)';
  for (const minimumReleaseAge of [1440, '10080', 'soon']) {
    assert.deepEqual(settingProblems(settings({ minimumReleaseAge })), [problem]);
  }
});

test('flags a weakened trust policy and settings that are not exactly true', () => {
  assert.deepEqual(settingProblems(settings({ trustPolicy: 'off' })), [
    'pnpm-workspace.yaml: trustPolicy is missing or weakened',
  ]);
  for (const key of ['blockExoticSubdeps', 'strictDepBuilds', 'saveExact']) {
    for (const value of ['true', false]) {
      assert.deepEqual(settingProblems(settings({ [key]: value })), [
        `pnpm-workspace.yaml: ${key} is missing or weakened`,
      ]);
    }
  }
});

test('flags every key of pnpm-workspace.yaml that is not on the allow-list', () => {
  const extra = settings({ packages: ['packages/*'], ignoredOptionalDependencies: ['x'] });
  assert.deepEqual(unexpectedWorkspaceKeys(extra), []);
  const hostile = settings({
    trustPolicyIgnoreAfter: 1,
    dangerouslyAllowAllBuilds: true,
    registry: 'https://evil.example/',
  });
  assert.deepEqual(unexpectedWorkspaceKeys(hostile), [
    'pnpm-workspace.yaml: setting trustPolicyIgnoreAfter is not on the allow-list; remove it or review the allow-list',
    'pnpm-workspace.yaml: setting dangerouslyAllowAllBuilds is not on the allow-list; remove it or review the allow-list',
    'pnpm-workspace.yaml: setting registry is not on the allow-list; remove it or review the allow-list',
  ]);
});

test('reads the file with a YAML parser, so flow forms are read as pnpm reads them', () => {
  const parsed = workspaceSettings(
    'allowBuilds: { esbuild: true }\nminimumReleaseAgeExclude: [a@1.0.0, b@1.0.0]\n',
  );
  assert.deepEqual(parsed, {
    allowBuilds: { esbuild: true },
    minimumReleaseAgeExclude: ['a@1.0.0', 'b@1.0.0'],
  });
  assert.ok(settingProblems(parsed).includes('pnpm-workspace.yaml: allowBuilds is missing or weakened'));
  assert.deepEqual(workspaceSettings('- not\n- a mapping\n'), {});
  assert.throws(() => workspaceSettings('a: [unclosed\n'));
});

test('accepts matching, in-date exceptions', () => {
  assert.deepEqual(exceptions([AGE, TRUST], {}, '2026-10-27'), []);
});

test('flags an exclude the file has that the exceptions lack, and the reverse', () => {
  assert.deepEqual(exceptions([TRUST], {}), [
    'minimumReleaseAgeExclude has numfmt@4.1.0 in pnpm-workspace.yaml but not in supply-chain-exceptions.json',
  ]);
  assert.deepEqual(exceptions([AGE], {}), [
    'trustPolicyExclude has semver@6.3.1 in pnpm-workspace.yaml but not in supply-chain-exceptions.json',
  ]);
  assert.deepEqual(exceptions([AGE, TRUST], { trustPolicyExclude: undefined }), [
    'semver@6.3.1 is in supply-chain-exceptions.json but not in trustPolicyExclude in pnpm-workspace.yaml',
  ]);
});

test('flags a flow-form exclude list with an extra entry', () => {
  const flow = workspaceSettings(
    'minimumReleaseAgeExclude: [numfmt@4.1.0, left-pad@1.3.0]\ntrustPolicyExclude: [semver@6.3.1]\n',
  );
  assert.deepEqual(exceptionProblems([AGE, TRUST], flow, '2026-10-23', LOCKED), [
    'minimumReleaseAgeExclude has left-pad@1.3.0 in pnpm-workspace.yaml but not in supply-chain-exceptions.json',
  ]);
});

test('flags an exclude list that is not a list of strings', () => {
  const problem = 'pnpm-workspace.yaml: trustPolicyExclude is not a list of name@version strings';
  assert.deepEqual(exceptions([AGE, TRUST], { trustPolicyExclude: 'semver@6.3.1' }), [problem]);
  assert.deepEqual(exceptions([AGE, TRUST], { trustPolicyExclude: [1] }), [problem]);
});

test('flags entries that are not an exact name@version, in either place', () => {
  assert.deepEqual(
    exceptions([AGE, { ...TRUST, spec: 'semver@^6.3.1' }], { trustPolicyExclude: ['semver@^6.3.1'] }),
    [
      'supply-chain-exceptions.json: semver@^6.3.1 is not an exact name@version',
      'pnpm-workspace.yaml: trustPolicyExclude entry semver@^6.3.1 is not an exact name@version',
    ],
  );
  assert.deepEqual(exceptions([AGE, TRUST], { trustPolicyExclude: ['semver'] }), [
    'pnpm-workspace.yaml: trustPolicyExclude entry semver is not an exact name@version',
    'trustPolicyExclude has semver in pnpm-workspace.yaml but not in supply-chain-exceptions.json',
    'semver@6.3.1 is in supply-chain-exceptions.json but not in trustPolicyExclude in pnpm-workspace.yaml',
  ]);
});

test('flags an expired release-age entry but never a trust entry', () => {
  assert.deepEqual(exceptions([AGE, TRUST], {}, '2026-10-28'), [
    'supply-chain-exceptions.json: numfmt@4.1.0 expired on 2026-10-27; remove it',
  ]);
  assert.deepEqual(exceptions([TRUST], { minimumReleaseAgeExclude: undefined }, '2099-01-01'), []);
});

test('flags an expiry that is not a real date or more than seven days away', () => {
  const label = 'supply-chain-exceptions.json: numfmt@4.1.0';
  assert.deepEqual(exceptions([{ ...AGE, expires: '9999-12-31' }, TRUST], {}), [
    `${label} expires on 9999-12-31, more than 7 days after 2026-10-23`,
  ]);
  assert.deepEqual(exceptions([{ ...AGE, expires: '2026-10-30' }, TRUST], {}), []);
  assert.deepEqual(exceptions([{ ...AGE, expires: '2026-10-31' }, TRUST], {}), [
    `${label} expires on 2026-10-31, more than 7 days after 2026-10-23`,
  ]);
  for (const expires of ['2026-13-45', '2026-02-30', '26-10-27', undefined, 20261027]) {
    assert.deepEqual(exceptions([{ ...AGE, expires }, TRUST], {}), [
      `${label} needs an expires date as a real YYYY-MM-DD`,
    ]);
  }
});

test('flags an exception that is not in the lockfile any more', () => {
  const stale = { ...TRUST, spec: 'gone@1.0.0' };
  assert.deepEqual(exceptions([AGE, TRUST, stale], { trustPolicyExclude: ['semver@6.3.1', 'gone@1.0.0'] }), [
    'supply-chain-exceptions.json: gone@1.0.0 is not in pnpm-lock.yaml; remove it',
  ]);
});

test('flags an entry with no reason', () => {
  assert.deepEqual(exceptions([AGE, { ...TRUST, reason: ' ' }], {}), [
    'supply-chain-exceptions.json: semver@6.3.1 has no reason',
  ]);
});

test('reports a malformed exceptions file instead of throwing', () => {
  assert.deepEqual(exceptionProblems({}, settings(), '2026-10-23', LOCKED), [
    'supply-chain-exceptions.json must be a list of entries',
  ]);
  assert.deepEqual(exceptions([null, AGE, TRUST], {}), [
    'supply-chain-exceptions.json: entry null is not an object',
  ]);
  assert.deepEqual(exceptions([AGE, TRUST, { kind: 'trust', reason: 'x' }], {}), [
    'supply-chain-exceptions.json: undefined is not an exact name@version',
  ]);
});

test('accepts effective values equal to the file, and a list unset in both', () => {
  const { trustPolicyExclude, ...withoutList } = GOOD_SETTINGS;
  assert.equal(trustPolicyExclude[0], 'semver@6.3.1');
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, GOOD_EFFECTIVE), []);
  assert.deepEqual(effectiveProblems(withoutList, effectiveWith({ trustPolicyExclude: undefined })), []);
});

test('a weak file is reported even when the effective value is strong', () => {
  const weakFile = settings({ trustPolicy: 'off', allowBuilds: { esbuild: true } });
  assert.deepEqual(settingProblems(weakFile), [
    'pnpm-workspace.yaml: trustPolicy is missing or weakened',
    'pnpm-workspace.yaml: allowBuilds is missing or weakened',
  ]);
  assert.deepEqual(effectiveProblems(weakFile, GOOD_EFFECTIVE), [
    'pnpm enforces trustPolicy = "no-downgrade", but pnpm-workspace.yaml has "off"',
    'pnpm enforces allowBuilds = {}, but pnpm-workspace.yaml has {"esbuild":true}',
  ]);
});

test('flags an effective value that differs from the file, or is unset', () => {
  const overridden = effectiveWith({ minimumReleaseAge: 0, trustPolicyExclude: undefined });
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, overridden), [
    'pnpm enforces minimumReleaseAge = 0, but pnpm-workspace.yaml has 10080',
    'pnpm enforces trustPolicyExclude = unset, but pnpm-workspace.yaml has ["semver@6.3.1"]',
  ]);
});

test('flags settings that weaken the policy when they come from outside the file', () => {
  const weakened = effectiveWith({
    trustPolicyIgnoreAfter: 1,
    dangerouslyAllowAllBuilds: true,
    minimumReleaseAgeStrict: false,
    minimumReleaseAgeIgnoreMissingTime: true,
    pnpmfile: './hook.cjs',
    configDependencies: { x: '1.0.0' },
  });
  const message = (key, value) => `pnpm enforces ${key} = ${value}, which weakens the supply-chain policy`;
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, weakened), [
    message('trustPolicyIgnoreAfter', '1'),
    message('configDependencies', '{"x":"1.0.0"}'),
    message('pnpmfile', '"./hook.cjs"'),
    message('dangerouslyAllowAllBuilds', 'true'),
    message('minimumReleaseAgeIgnoreMissingTime', 'true'),
    message('minimumReleaseAgeStrict', 'false'),
  ]);
});

test('flags a registry other than registry.npmjs.org and any scoped registry except the jsr default', () => {
  const hostile = effectiveWith({
    registry: 'https://evil.example/',
    '@jsr:registry': 'https://evil.example/',
    '@acme:registry': NPM,
  });
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, hostile), [
    'pnpm enforces registry = "https://evil.example/"; it must be https://registry.npmjs.org/',
    'pnpm enforces @jsr:registry = "https://evil.example/"; no scoped registry is allowed',
    'pnpm enforces @acme:registry = "https://registry.npmjs.org/"; no scoped registry is allowed',
  ]);
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, effectiveWith({ registry: undefined })), [
    'pnpm enforces registry = unset; it must be https://registry.npmjs.org/',
  ]);
});

test('flags effective settings pnpm cannot report', () => {
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, { status: 'unreadable' }), [
    'pnpm could not report its effective settings',
  ]);
});

test('reports that effective settings could not be verified when npm_execpath is missing', () => {
  assert.deepEqual(effectiveSettings({}), { status: 'unavailable' });
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, effectiveSettings({})), [
    'effective pnpm settings could not be verified: run this check through pnpm so npm_execpath is set',
  ]);
});

test('an unusable pnpm entry is unreadable, not unavailable', () => {
  assert.deepEqual(effectiveSettings({ npm_execpath: '/nonexistent/pnpm.cjs' }), { status: 'unreadable' });
});

test('flags a pnpmfile in the root or in any workspace package', () => {
  const dirs = ['.', 'packages/a'];
  assert.deepEqual(
    pnpmfileProblems(dirs, () => false),
    [],
  );
  assert.deepEqual(
    pnpmfileProblems(dirs, (file) => file === 'packages/a/.pnpmfile.mjs'),
    ['packages/a/.pnpmfile.mjs exists; pnpm runs it on install, before this check'],
  );
  assert.deepEqual(
    pnpmfileProblems(dirs, () => true),
    [
      '.pnpmfile.mjs exists; pnpm runs it on install, before this check',
      '.pnpmfile.cjs exists; pnpm runs it on install, before this check',
      'packages/a/.pnpmfile.mjs exists; pnpm runs it on install, before this check',
      'packages/a/.pnpmfile.cjs exists; pnpm runs it on install, before this check',
    ],
  );
});

test('folds kebab-case settings into camelCase and rejects duplicates', () => {
  const kebab = { status: 'ok', settings: { ...GOOD_EFFECTIVE.settings, 'strict-dep-builds': true } };
  delete kebab.settings.strictDepBuilds;
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, kebab), []);
  const weakKebab = {
    status: 'ok',
    settings: { ...GOOD_EFFECTIVE.settings, 'trust-policy-ignore-after': 1 },
  };
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, weakKebab), [
    'pnpm enforces trustPolicyIgnoreAfter = 1, which weakens the supply-chain policy',
  ]);
  const duplicated = { status: 'ok', settings: { ...GOOD_EFFECTIVE.settings, 'save-exact': false } };
  assert.deepEqual(effectiveProblems(GOOD_SETTINGS, duplicated), [
    'pnpm reports saveExact more than once (as save-exact and another spelling); remove the duplicate',
    'pnpm enforces saveExact = false, but pnpm-workspace.yaml has true',
  ]);
});

const FULL_CODEOWNERS = [
  '# comment',
  '/.github/ @OWNER',
  '/scripts/check-supply-chain* @OWNER',
  '/supply-chain-exceptions.json @OWNER',
  '/pnpm-workspace.yaml @OWNER',
  '/pnpm-lock.yaml @OWNER',
  '.npmrc @OWNER',
  '**/package.json @OWNER',
  '**/.pnpmfile.* @OWNER',
].join('\n');

test('requires a CODEOWNERS file that covers the gate and the dependency files', () => {
  assert.deepEqual(codeownersProblems(FULL_CODEOWNERS), []);
  assert.deepEqual(codeownersProblems(undefined), ['.github/CODEOWNERS is missing']);
});

test('judges ownership by glob, last matching rule wins', () => {
  const uncovered = codeownersProblems('/.github/ @OWNER\n');
  assert.ok(uncovered.includes('.github/CODEOWNERS: scripts/check-supply-chain.test.mjs has no code owner'));
  assert.ok(uncovered.includes('.github/CODEOWNERS: packages/example/.pnpmfile.cjs has no code owner'));
  assert.ok(uncovered.includes('.github/CODEOWNERS: .npmrc has no code owner'));
  assert.equal(
    uncovered.includes('.github/CODEOWNERS: .github/workflows/security.yml has no code owner'),
    false,
  );
});

test('a later rule without owners un-owns what it matches', () => {
  const text = `${FULL_CODEOWNERS}\n/pnpm-lock.yaml\n*.json\n`;
  assert.deepEqual(codeownersProblems(text), [
    '.github/CODEOWNERS line 10: /pnpm-lock.yaml has no owner, which removes ownership from what it matches',
    '.github/CODEOWNERS line 11: *.json has no owner, which removes ownership from what it matches',
    '.github/CODEOWNERS: supply-chain-exceptions.json has no code owner',
    '.github/CODEOWNERS: pnpm-lock.yaml has no code owner',
    '.github/CODEOWNERS: package.json has no code owner',
    '.github/CODEOWNERS: packages/example/package.json has no code owner',
  ]);
});

test('a later rule with owners restores what an earlier ownerless rule removed', () => {
  assert.deepEqual(codeownersProblems(`*.json\n${FULL_CODEOWNERS}\n`), [
    '.github/CODEOWNERS line 1: *.json has no owner, which removes ownership from what it matches',
  ]);
});

test('names the @OWNER placeholder only when asked to', () => {
  assert.deepEqual(placeholderOwnerProblems(FULL_CODEOWNERS), [
    '.github/CODEOWNERS still names the placeholder @OWNER; replace it with the maintainers GitHub user or team',
  ]);
  assert.deepEqual(placeholderOwnerProblems('/pnpm-lock.yaml @acme/maintainers\n'), []);
  assert.deepEqual(placeholderOwnerProblems(undefined), []);
});

const SHA = 'a'.repeat(40);
const workflow = ({ top = '', jobEnv = '', stepEnv = '', extraSteps = '', jobExtra = '' }) =>
  `${top}jobs:\n  audit:\n${jobEnv}${jobExtra}    steps:\n      - uses: actions/checkout@${SHA}\n      - run: pnpm audit\n${stepEnv}${extraSteps}`;
const BOTH_ENV =
  "    env:\n      pnpm_config_ignore_pnpmfile: 'true'\n      pnpm_config_verify_deps_before_run: 'false'\n";
const IGNORE = 'pnpm_config_ignore_pnpmfile';
const VERIFY = 'pnpm_config_verify_deps_before_run';

test('requires both pnpm hardening variables to hold for every step that runs pnpm', () => {
  assert.deepEqual(workflowProblems(workflow({ jobEnv: BOTH_ENV })), []);
  assert.deepEqual(workflowProblems(workflow({})), [
    `workflow job audit step 2 runs pnpm but its effective env ${IGNORE} is not 'true'`,
    `workflow job audit step 2 runs pnpm but its effective env ${VERIFY} is not 'false'`,
  ]);
  const wrong =
    "    env:\n      pnpm_config_ignore_pnpmfile: 'true'\n      pnpm_config_verify_deps_before_run: 'true'\n";
  assert.deepEqual(workflowProblems(workflow({ jobEnv: wrong })), [
    `workflow job audit step 2 runs pnpm but its effective env ${VERIFY} is not 'false'`,
  ]);
  assert.deepEqual(workflowProblems('name: x\n'), ['workflow has no jobs this check can read']);
});

test('accepts hardening set at the workflow level', () => {
  const top = "env:\n  pnpm_config_ignore_pnpmfile: 'true'\n  pnpm_config_verify_deps_before_run: 'false'\n";
  assert.deepEqual(workflowProblems(workflow({ top })), []);
});

test('a step-level env cannot override the hardening variables', () => {
  const stepEnv = "        env:\n          pnpm_config_ignore_pnpmfile: 'false'\n";
  assert.deepEqual(workflowProblems(workflow({ jobEnv: BOTH_ENV, stepEnv })), [
    `workflow job audit step 2 runs pnpm but its effective env ${IGNORE} is not 'true'`,
  ]);
});

test('any other pnpm_config or npm_config key in an env is reported', () => {
  const top = 'env:\n  pnpm_config_pnpmfile: ./hook.cjs\n';
  assert.deepEqual(workflowProblems(workflow({ top, jobEnv: BOTH_ENV })), [
    'workflow env sets pnpm_config_pnpmfile, which is not on the allow-list',
  ]);
  const jobEnv = `${BOTH_ENV}      NPM_CONFIG_REGISTRY: https://evil.example/\n`;
  const stepEnv = "        env:\n          npm_config_ignore_scripts: 'false'\n";
  assert.deepEqual(workflowProblems(workflow({ jobEnv, stepEnv })), [
    'workflow job audit env sets NPM_CONFIG_REGISTRY, which is not on the allow-list',
    'workflow job audit step 2 env sets npm_config_ignore_scripts, which is not on the allow-list',
  ]);
});

test('an unknown action, a tag-pinned action and a short SHA are reported', () => {
  const extraSteps = `      - uses: evil/action@${SHA}\n      - uses: actions/setup-node@v4\n      - uses: pnpm/action-setup@${'b'.repeat(39)}\n      - uses: ./local\n`;
  const notAllowed = (n, uses) =>
    `workflow job audit step ${n} uses ${uses}, which is not an allowed action pinned to a full commit SHA`;
  assert.deepEqual(workflowProblems(workflow({ jobEnv: BOTH_ENV, extraSteps })), [
    notAllowed(3, `evil/action@${SHA}`),
    notAllowed(4, 'actions/setup-node@v4'),
    notAllowed(5, `pnpm/action-setup@${'b'.repeat(39)}`),
    notAllowed(6, './local'),
  ]);
});

test('a job that calls a reusable workflow is reported', () => {
  const text = 'jobs:\n  shared:\n    uses: org/repo/.github/workflows/x.yml@main\n';
  assert.deepEqual(workflowProblems(text), [
    'workflow job shared calls the reusable workflow org/repo/.github/workflows/x.yml@main, which this check cannot read',
  ]);
});

test('security.yml sets both variables on its pnpm job', () => {
  const text = readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8');
  assert.deepEqual(workflowProblems(text), []);
});

test('effectiveSettings runs pnpm with its pnpmfile ignored', () => {
  let seen;
  const exec = (file, args, options) => {
    seen = { file, args, options };
    return '{"saveExact":true}';
  };
  const result = effectiveSettings({ npm_execpath: '/p/pnpm.cjs', KEEP: '1' }, exec);
  assert.deepEqual(result, { status: 'ok', settings: { saveExact: true } });
  assert.equal(seen.options.env.pnpm_config_ignore_pnpmfile, 'true');
  assert.equal(seen.options.env.KEEP, '1');
  assert.deepEqual(seen.args, ['/p/pnpm.cjs', 'config', 'list', '--json']);
});

const underPnpm = { skip: !process.env.npm_execpath && 'run through pnpm so npm_execpath is set' };

test(
  'the repository passes with the values pnpm reports, on a date inside every expiry window',
  underPnpm,
  () => {
    assert.deepEqual(collectProblems('2026-10-23', effectiveSettings), []);
  },
);

test('the repository is clean for a release once @OWNER is replaced, and not before', underPnpm, () => {
  assert.deepEqual(collectProblems('2026-10-23', effectiveSettings, { release: true }), [
    '.github/CODEOWNERS still names the placeholder @OWNER; replace it with the maintainers GitHub user or team',
  ]);
});

test('a setting pnpm cannot report fails the check', underPnpm, () => {
  assert.deepEqual(
    collectProblems('2026-10-23', () => ({ status: 'unreadable' })),
    ['pnpm could not report its effective settings'],
  );
});

test('the CLI exits 0 on the repository', underPnpm, () => {
  const script = fileURLToPath(new URL('./check-supply-chain.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { stdio: 'pipe' });
});
