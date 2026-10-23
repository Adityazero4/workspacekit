import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCli } from '../src/runCli.ts';
import { createWorkspace, type TemplateName } from '../src/index.ts';

const runFile = promisify(execFile);
const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const PINNED = '9.8.7';
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));

function packageNamesIn(folder: string): string[] {
  const directory = path.join(REPOSITORY, folder);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((entry) => path.join(directory, entry, 'package.json'))
    .filter((manifest) => existsSync(manifest))
    .map((manifest) => (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name);
}

const PUBLISHABLE_NAMES = new Set(
  readdirSync(path.join(REPOSITORY, 'packages'))
    .filter((entry) => entry !== '_template')
    .map((entry) => path.join(REPOSITORY, 'packages', entry, 'package.json'))
    .filter((manifest) => existsSync(manifest))
    .map((manifest) => (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name),
);
const VERSIONS = Object.fromEntries(
  ['packages', 'examples', 'apps'].flatMap(packageNamesIn).map((name) => [name, PINNED]),
);

const EXPECTED_FILES: Record<TemplateName, string[]> = {
  next: [
    '.gitignore',
    'README.md',
    'app/api/files/[...path]/route.ts',
    'app/layout.tsx',
    'app/page.tsx',
    'lib/auth.ts',
    'next-env.d.ts',
    'next.config.ts',
    'package.json',
    'proxy.ts',
    'scripts/agent.mjs',
    'tsconfig.json',
  ],
  vite: [
    '.gitignore',
    'README.md',
    'index.html',
    'package.json',
    'src/App.tsx',
    'src/app.css',
    'src/fileSystemAccessAdapter.ts',
    'src/main.tsx',
    'tsconfig.json',
    'vite.config.ts',
  ],
};

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(directory, relative)));
    else found.push(relative);
  }
  return found.sort();
}

function relativeImportSpecifiers(source: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]*)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

let sandbox: string;
const generated = {} as Record<TemplateName, string>;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'create-workspace-'));
  for (const template of ['next', 'vite'] as const) {
    generated[template] = path.join(sandbox, template);
    await createWorkspace({ template, directory: generated[template], versions: VERSIONS });
  }
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('createWorkspace', () => {
  for (const template of ['next', 'vite'] as const) {
    describe(`template "${template}"`, () => {
      it('produces exactly the expected files', async () => {
        assert.deepEqual(await listFiles(generated[template]), EXPECTED_FILES[template]);
      });

      it('has no workspace:, file: or link: ranges and pins every @scope package exactly', async () => {
        const manifest = JSON.parse(await readFile(path.join(generated[template], 'package.json'), 'utf8'));
        const ranges = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
        for (const [name, range] of Object.entries(ranges)) {
          assert.doesNotMatch(range, /^(workspace|file|link):/, `${name} is ${range}`);
          if (name.startsWith('@scope/')) assert.equal(range, PINNED, name);
        }
        assert.ok(Object.keys(ranges).some((name) => name.startsWith('@scope/')));
        assert.equal(manifest.name, template);
      });

      it('depends only on publishable packages under packages/, never on examples/ or apps/', async () => {
        const manifest = JSON.parse(await readFile(path.join(generated[template], 'package.json'), 'utf8'));
        const ranges = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
        for (const name of Object.keys(ranges).filter((dependency) => dependency.startsWith('@scope/'))) {
          assert.ok(PUBLISHABLE_NAMES.has(name), `${name} is not a package under packages/`);
        }
      });

      it('has no relative import that leaves the project and no monorepo config', async () => {
        const root = generated[template];
        for (const file of await listFiles(root)) {
          assert.notEqual(file, 'tsconfig.monorepo.json');
          if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
          const source = await readFile(path.join(root, file), 'utf8');
          for (const specifier of relativeImportSpecifiers(source)) {
            const target = path.resolve(root, path.dirname(file), specifier);
            assert.ok(target.startsWith(`${root}${path.sep}`), `${file} imports ${specifier}`);
          }
        }
      });

      it('keeps no test-only scripts or dependencies and typechecks with the self-contained tsconfig', async () => {
        const manifest = JSON.parse(await readFile(path.join(generated[template], 'package.json'), 'utf8'));
        assert.equal(
          manifest.scripts.typecheck,
          template === 'next' ? 'next typegen && tsc --noEmit' : 'tsc --noEmit',
        );
        assert.equal(manifest.scripts.build, template === 'next' ? 'next build' : 'vite build');
        assert.equal(manifest.scripts.start, template === 'next' ? 'next start' : undefined);
        assert.equal(manifest.scripts.test, undefined);
        assert.equal(manifest.scripts['test:e2e'], undefined);
        assert.equal(manifest.devDependencies['@playwright/test'], undefined);
        assert.ok(manifest.devDependencies.typescript);
      });

      it('ignores installed packages, build output and local env files', async () => {
        const ignored = await readFile(path.join(generated[template], '.gitignore'), 'utf8');
        for (const entry of ['node_modules', 'dist', '.env*.local']) {
          assert.ok(ignored.includes(entry), entry);
        }
      });

      it('has no monorepo-only text in the README', async () => {
        const readme = await readFile(path.join(generated[template], 'README.md'), 'utf8');
        assert.doesNotMatch(readme, /pnpm|monorepo|check:full|<!--/);
        assert.match(readme, /npm run dev/);
      });
    });
  }

  it('refuses a non-empty directory and names it', async () => {
    const occupied = path.join(sandbox, 'occupied');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'keep.txt'), 'mine');
    await assert.rejects(
      createWorkspace({ template: 'next', directory: occupied, versions: VERSIONS }),
      (error: Error) => error.message.includes(occupied) && /not empty/.test(error.message),
    );
    assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'mine');
  });

  it('refuses an unknown template and lists the valid ones', async () => {
    await assert.rejects(
      createWorkspace({
        template: 'x' as TemplateName,
        directory: path.join(sandbox, 'unknown'),
        versions: VERSIONS,
      }),
      (error: Error) => /"x"/.test(error.message) && /next/.test(error.message) && /vite/.test(error.message),
    );
  });

  it('refuses a target that is an existing file with a message that names it', async () => {
    const file = path.join(sandbox, 'a-file');
    await writeFile(file, 'x');
    await assert.rejects(
      createWorkspace({ template: 'next', directory: file, versions: VERSIONS }),
      (error: Error) => error.message.includes(file) && /file, not a directory/.test(error.message),
    );
  });

  it('refuses when a version is missing and writes nothing', async () => {
    const directory = path.join(sandbox, 'missing-version');
    await assert.rejects(createWorkspace({ template: 'next', directory, versions: {} }), /@scope\//);
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
  });
});

const RELEASED = Object.fromEntries(
  Object.keys(VERSIONS).map((name) => [name, { version: PINNED, private: false }]),
);

describe('publish gate', () => {
  it('refuses a dependency whose package is private and names it', async () => {
    const directory = path.join(sandbox, 'gate-private');
    await assert.rejects(
      createWorkspace({
        template: 'vite',
        directory,
        versions: VERSIONS,
        privatePackages: ['@scope/demo-kit'],
      }),
      (error: Error) =>
        /not published yet: .*@scope\/demo-kit/.test(error.message) &&
        /once they are released/.test(error.message),
    );
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
  });

  it('refuses a dependency at version 0.0.0', async () => {
    const directory = path.join(sandbox, 'gate-zero');
    await assert.rejects(
      createWorkspace({ template: 'next', directory, versions: { ...VERSIONS, '@scope/core': '0.0.0' } }),
      /not published yet: .*@scope\/core/,
    );
  });

  it('fails loudly, naming the package, when a template dependency has no version', async () => {
    const { '@scope/demo-kit': _omitted, ...withoutDemoKit } = VERSIONS;
    await assert.rejects(
      createWorkspace({
        template: 'vite',
        directory: path.join(sandbox, 'gate-missing'),
        versions: withoutDemoKit,
      }),
      /No version was given for @scope\/demo-kit/,
    );
  });
});

describe('create-workspace command', () => {
  it('exits 1 for an unknown --template and lists the valid ones', async () => {
    await assert.rejects(
      runFile(process.execPath, [CLI, path.join(sandbox, 'cli-x'), '--template', 'x']),
      (error) => {
        const { code, stderr } = error as { code: number; stderr: string };
        return code === 1 && stderr.includes('next') && stderr.includes('vite');
      },
    );
  });

  it('refuses by default while the packages are private or at 0.0.0', async () => {
    const directory = path.join(sandbox, 'cli-default');
    await assert.rejects(runFile(process.execPath, [CLI, directory]), (error) => {
      const { code, stderr } = error as { code: number; stderr: string };
      return code === 1 && stderr.includes('not published yet');
    });
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
  });

  it('creates the default template once the releases are published', async () => {
    const directory = path.join(sandbox, 'cli-released');
    const message = await runCli([directory], async () => RELEASED);
    assert.ok((await listFiles(directory)).includes('proxy.ts'));
    assert.match(message, /npm install/);
  });

  it('refuses when a release is flagged private', async () => {
    const releases = { ...RELEASED, '@scope/core': { version: PINNED, private: true } };
    await assert.rejects(
      runCli([path.join(sandbox, 'cli-private')], async () => releases),
      /not published yet/,
    );
  });
});
