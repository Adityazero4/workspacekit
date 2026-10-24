import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishArguments, releaseProblems } from './release.mjs';

const ready = {
  version: '0.1.0',
  publishConfig: { access: 'public', provenance: true },
  repository: {
    type: 'git',
    url: 'git+https://github.com/Adityazero4/workspacekit.git',
    directory: 'packages/core',
  },
};

test('a tag whose version every ready package carries can be released', () => {
  assert.deepEqual(releaseProblems('v0.1.0', [{ folder: 'core', manifest: ready }]), []);
  assert.deepEqual(
    releaseProblems('v0.1.0-rc.1', [{ folder: 'core', manifest: { ...ready, version: '0.1.0-rc.1' } }]),
    [],
  );
});

test('a tag that is not v plus semver is refused before any package is read', () => {
  for (const tag of ['0.1.0', 'v0.1', 'release-1', 'v0.1.0;rm', undefined]) {
    assert.deepEqual(releaseProblems(tag, []), [`the tag ${tag} is not v followed by a semver version`]);
  }
});

test('every package that is not ready says why', () => {
  const problems = releaseProblems('v0.1.0', [
    { folder: 'core', manifest: { version: '0.0.0', private: true } },
    {
      folder: 'server',
      manifest: { ...ready, repository: { url: 'git+https://github.com/someone/fork.git' } },
    },
  ]);
  assert.deepEqual(problems, [
    'packages/core/package.json has version 0.0.0, not 0.1.0',
    'packages/core/package.json is private',
    'packages/core/package.json needs publishConfig.access "public"',
    'packages/core/package.json needs publishConfig.provenance true',
    'packages/core/package.json needs repository.url git+https://github.com/Adityazero4/workspacekit.git',
    'packages/server/package.json needs repository.url git+https://github.com/Adityazero4/workspacekit.git',
  ]);
});

test('a release publishes publicly with provenance, and a prerelease never becomes latest', () => {
  assert.deepEqual(publishArguments('core.tgz', '0.1.0'), [
    'publish',
    'core.tgz',
    '--access',
    'public',
    '--provenance',
  ]);
  assert.deepEqual(publishArguments('core.tgz', '0.1.0-rc.1').slice(-2), ['--tag', 'next']);
});
