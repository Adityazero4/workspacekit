import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packProblems } from './check-pack.mjs';

function goodPack() {
  return new Map([
    [
      'package/package.json',
      JSON.stringify({
        name: '@workspacekit/x',
        repository: {
          type: 'git',
          url: 'git+https://github.com/Adityazero4/workspacekit.git',
          directory: 'packages/x',
        },
        homepage: 'https://docs-ashy-alpha.vercel.app',
        bugs: 'https://github.com/Adityazero4/workspacekit/issues',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    ],
    ['package/dist/index.js', 'export {};\n//# sourceMappingURL=index.js.map'],
    ['package/dist/index.d.ts', 'export {};'],
    ['package/dist/index.js.map', '{"sources":["../src/index.ts"]}'],
    ['package/README.md', ''],
    ['package/AGENTS.md', ''],
    ['package/llms.txt', ''],
    ['package/LICENSE', ''],
    ['package/NOTICE', ''],
  ]);
}

function problemsWith(change, options) {
  const pack = goodPack();
  change(pack);
  return packProblems(pack, options);
}

function withManifest(edit) {
  return (pack) => {
    const manifest = JSON.parse(pack.get('package/package.json'));
    edit(manifest);
    pack.set('package/package.json', JSON.stringify(manifest));
  };
}

test('accepts a clean tarball', () => {
  assert.deepEqual(packProblems(goodPack()), []);
});

test('rejects a source file', () => {
  assert.match(
    problemsWith((p) => p.set('package/src/x.ts', '')).join('\n'),
    /unexpected file package\/src\/x\.ts/,
  );
});

test('rejects a source map that names a home directory', () => {
  const problems = problemsWith((p) => p.set('package/dist/index.js.map', '{"sources":["/Users/me/a.ts"]}'));
  assert.match(problems.join('\n'), /dist\/index\.js\.map contains a machine path/);
});

test('rejects a sourceMappingURL that leaves the package', () => {
  const problems = problemsWith((p) => p.set('package/dist/index.js', '//# sourceMappingURL=../../x.map'));
  assert.match(problems.join('\n'), /sourceMappingURL points outside/);
});

test('rejects workspace:, file: and link: ranges', () => {
  for (const range of ['workspace:*', 'file:../x', 'link:../x']) {
    const problems = problemsWith(withManifest((manifest) => (manifest.dependencies = { y: range })));
    assert.match(problems.join('\n'), /local range/);
  }
});

test('rejects an exports target that is not in the tarball', () => {
  const problems = problemsWith((p) => p.delete('package/dist/index.d.ts'));
  assert.match(problems.join('\n'), /exports target \.\/dist\/index\.d\.ts is missing/);
});

test('rejects each missing required file', () => {
  for (const name of ['README.md', 'AGENTS.md', 'llms.txt', 'LICENSE', 'NOTICE']) {
    const problems = problemsWith((p) => p.delete(`package/${name}`));
    assert.match(problems.join('\n'), new RegExp(`missing package/${name.replace('.', '\\.')}`));
  }
});

test('rejects a missing repository, homepage or bugs field', () => {
  for (const field of ['repository', 'homepage', 'bugs']) {
    const problems = problemsWith(withManifest((manifest) => delete manifest[field]));
    assert.match(problems.join('\n'), new RegExp(`package.json ${field} must be`));
  }
});

test('rejects a repository that names another folder or another repository', () => {
  const otherFolder = problemsWith(
    withManifest((manifest) => (manifest.repository.directory = 'packages/y')),
  );
  assert.match(otherFolder.join('\n'), /package.json repository must be/);
  const otherUrl = problemsWith(
    withManifest((manifest) => (manifest.repository.url = 'git+https://github.com/someone/fork.git')),
  );
  assert.match(otherUrl.join('\n'), /package.json repository must be/);
});

test('rejects machine paths in dist: the repository root, /home/ and C:\\Users\\', () => {
  const repositoryRoot = '/srv/build/workspacekit';
  for (const machinePath of [
    `${repositoryRoot}/packages/x/src/a.ts`,
    '/home/runner/a.ts',
    'C:\\Users\\me\\a.ts',
  ]) {
    const problems = problemsWith(
      (p) => p.set('package/dist/index.js.map', JSON.stringify({ sources: [machinePath] })),
      { repositoryRoot },
    );
    assert.match(problems.join('\n'), /dist\/index\.js\.map contains a machine path/, machinePath);
  }
});
