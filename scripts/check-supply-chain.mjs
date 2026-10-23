import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const MIN_RELEASE_AGE_MINUTES = 10080;
const MAX_EXCEPTION_DAYS = 7;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXACT_SPEC = /^(@?[^@\s]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PINNED_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const JSR_REGISTRY = 'https://npm.jsr.io/';
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const REQUIRED_SETTINGS = {
  trustPolicy: (value) => value === 'no-downgrade',
  blockExoticSubdeps: (value) => value === true,
  strictDepBuilds: (value) => value === true,
  saveExact: (value) => value === true,
  allowBuilds: (value) => isPlainObject(value) && Object.values(value).every((allowed) => allowed === false),
  minimumReleaseAge: (value) => typeof value === 'number' && value >= MIN_RELEASE_AGE_MINUTES,
};
const EXCEPTION_KINDS = { 'release-age': 'minimumReleaseAgeExclude', trust: 'trustPolicyExclude' };
const SETTING_KEYS = [...Object.keys(REQUIRED_SETTINGS), 'minimumReleaseAgeExclude', 'trustPolicyExclude'];
const ALLOWED_WORKSPACE_KEYS = ['packages', 'ignoredOptionalDependencies', ...SETTING_KEYS];
const UNSET = (value) => value === undefined;
const WEAKENING_SETTINGS = {
  trustPolicyIgnoreAfter: UNSET,
  configDependencies: UNSET,
  pnpmfile: UNSET,
  globalPnpmfile: UNSET,
  onlyBuiltDependencies: UNSET,
  neverBuiltDependencies: UNSET,
  onlyBuiltDependenciesFile: UNSET,
  overrides: UNSET,
  packageExtensions: UNSET,
  patchedDependencies: UNSET,
  namedRegistries: UNSET,
  dangerouslyAllowAllBuilds: (value) => value === undefined || value === false,
  minimumReleaseAgeIgnoreMissingTime: (value) => value === undefined || value === false,
  minimumReleaseAgeStrict: (value) => value === undefined || value === true,
};
const FORBIDDEN_LOCKFILE_KEYS = [
  'overrides',
  'patchedDependencies',
  'pnpmfileChecksum',
  'packageExtensionsChecksum',
];
const FORBIDDEN_MANIFEST_FIELDS = ['overrides', 'resolutions', 'pnpm'];
const PNPMFILES = ['.pnpmfile.mjs', '.pnpmfile.cjs'];
const CODEOWNER_PROTECTED_PATHS = [
  '.github/workflows/security.yml',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  'scripts/check-supply-chain.mjs',
  'scripts/check-supply-chain.test.mjs',
  'supply-chain-exceptions.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package.json',
  'packages/example/package.json',
  '.npmrc',
  'packages/example/.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'packages/example/.pnpmfile.cjs',
  'packages/example/.pnpmfile.mjs',
];
const OWNER_PLACEHOLDER = '@OWNER';
const WORKSPACE_GLOB = /^[\w.-]+(?:\/[\w.-]+)*(?:\/\*)?$/;

/**
 * Every setting pnpm enforces once `.npmrc` files, environment variables and global config are applied, from
 * `pnpm config list --json`. The result is `{ status: 'ok', settings }`, `{ status: 'unreadable' }` (pnpm
 * failed, or printed something that is not a JSON object) or `{ status: 'unavailable' }` (not run by pnpm, so
 * `npm_execpath` is missing). It runs the pnpm that is running this script, by `env.npm_execpath`, from the
 * repository root, never a `pnpm` found on PATH, with `pnpm_config_ignore_pnpmfile` set so a pnpmfile's
 * `updateConfig` cannot rewrite what is read. `exec` stands in for `execFileSync` in tests.
 *
 * @example
 * effectiveSettings({ npm_execpath: '/path/to/pnpm.cjs' });
 * // { status: 'ok', settings: { saveExact: true, … } }
 */
export function effectiveSettings(env = process.env, exec = execFileSync) {
  if (!env.npm_execpath) return { status: 'unavailable' };
  try {
    const output = exec(process.execPath, [env.npm_execpath, 'config', 'list', '--json'], {
      cwd: ROOT_PATH,
      env: { ...env, pnpm_config_ignore_pnpmfile: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settings = JSON.parse(output);
    return isPlainObject(settings) ? { status: 'ok', settings } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * The settings `pnpm-workspace.yaml` itself holds, parsed with a real YAML parser. Anything that is not a
 * mapping reads as no settings, so every required one is then reported missing.
 *
 * @example
 * workspaceSettings('saveExact: true\n'); // { saveExact: true }
 */
export function workspaceSettings(text) {
  const parsed = YAML.parse(text);
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * The top-level keys of `pnpm-workspace.yaml` outside the allow-list (the workspace globs, the ignored
 * optional dependencies, the required settings and the two exclude lists). Any other key could weaken the
 * policy, such as `pnpmfile`, `configDependencies`, `registry` or `trustPolicyIgnoreAfter`.
 *
 * @example
 * unexpectedWorkspaceKeys({ saveExact: true, registry: 'https://evil.example/' });
 * // ['pnpm-workspace.yaml: setting registry is not on the allow-list; remove it or review the allow-list']
 */
export function unexpectedWorkspaceKeys(settings) {
  return Object.keys(settings)
    .filter((key) => !ALLOWED_WORKSPACE_KEYS.includes(key))
    .map(
      (key) =>
        `pnpm-workspace.yaml: setting ${key} is not on the allow-list; remove it or review the allow-list`,
    );
}

const asJson = (value) => (value === undefined ? 'unset' : JSON.stringify(value));

const camelCase = (key) => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function camelCased(raw) {
  const settings = {};
  const duplicates = [];
  for (const [key, value] of Object.entries(raw)) {
    const name = camelCase(key);
    if (Object.hasOwn(settings, name)) {
      duplicates.push(
        `pnpm reports ${name} more than once (as ${key} and another spelling); remove the duplicate`,
      );
    }
    settings[name] = value;
  }
  return { settings, duplicates };
}

function registryProblems(effective) {
  const scoped = Object.entries(effective).filter(([key]) => /^@[^:]+:registry$/.test(key));
  return [
    ...(effective.registry === NPM_REGISTRY
      ? []
      : [`pnpm enforces registry = ${asJson(effective.registry)}; it must be ${NPM_REGISTRY}`]),
    ...scoped
      .filter(([key, value]) => key !== '@jsr:registry' || value !== JSR_REGISTRY)
      .map(([key, value]) => `pnpm enforces ${key} = ${asJson(value)}; no scoped registry is allowed`),
  ];
}

/**
 * Differences between the committed file and what pnpm enforces: something outside the file, such as an
 * `.npmrc`, an environment variable or the global config, overrides a required setting, sets a setting that
 * weakens the policy (a pnpmfile, a looser trust policy, another registry), or the effective settings cannot
 * be read at all. `effective` is the result of `effectiveSettings`, or a stand-in with the same shape.
 *
 * @example
 * effectiveProblems({ saveExact: true }, { status: 'ok', settings: { saveExact: false } });
 * // ['pnpm enforces saveExact = false, but pnpm-workspace.yaml has true', …]
 */
export function effectiveProblems(fileSettings, effective) {
  if (effective.status === 'unavailable') {
    return [
      'effective pnpm settings could not be verified: run this check through pnpm so npm_execpath is set',
    ];
  }
  if (effective.status !== 'ok') return ['pnpm could not report its effective settings'];
  const { settings, duplicates } = camelCased(effective.settings);
  const differing = SETTING_KEYS.filter((key) => !isDeepStrictEqual(settings[key], fileSettings[key])).map(
    (key) =>
      `pnpm enforces ${key} = ${asJson(settings[key])}, but pnpm-workspace.yaml has ${asJson(fileSettings[key])}`,
  );
  const weakening = Object.entries(WEAKENING_SETTINGS)
    .filter(([key, accepts]) => !accepts(settings[key]))
    .map(([key]) => `pnpm enforces ${key} = ${asJson(settings[key])}, which weakens the supply-chain policy`);
  return [...duplicates, ...differing, ...weakening, ...registryProblems(settings)];
}

/**
 * Every dependency in `dependencies`, `devDependencies` or `optionalDependencies` that is neither a
 * `workspace:` link nor an exact version. Peer ranges are not looked at.
 *
 * @example
 * unpinnedDependencies([{ file: 'package.json', json: { dependencies: { react: '^19.0.0' } } }]);
 * // ['package.json: dependencies.react is "^19.0.0", not an exact version']
 */
export function unpinnedDependencies(manifests) {
  return manifests.flatMap(({ file, json }) =>
    PINNED_SECTIONS.flatMap((section) =>
      Object.entries(json[section] ?? {})
        .filter(([, range]) => !range.startsWith('workspace:') && !EXACT_VERSION.test(range))
        .map(([name, range]) => `${file}: ${section}.${name} is "${range}", not an exact version`),
    ),
  );
}

function parseLockfile(text) {
  try {
    const document = YAML.parse(text);
    return isPlainObject(document) ? { document } : { error: 'is not a YAML mapping' };
  } catch (error) {
    return { error: `does not parse as YAML: ${error.message}` };
  }
}

const withoutPeerSuffix = (key) => key.replace(/\(.*$/, '');

function resolutionProblems(name, entry) {
  const resolution = isPlainObject(entry) ? entry.resolution : undefined;
  if (!isPlainObject(resolution)) return [`pnpm-lock.yaml: ${name} has no readable resolution`];
  const extra = Object.keys(resolution).filter((field) => field !== 'integrity');
  if (extra.length > 0) {
    return [`pnpm-lock.yaml: ${name} has resolution fields other than integrity: ${extra.join(', ')}`];
  }
  return typeof resolution.integrity === 'string' && SHA512_INTEGRITY.test(resolution.integrity)
    ? []
    : [`pnpm-lock.yaml: ${name} has no sha512 resolution integrity`];
}

/**
 * Every entry of the lockfile's `packages` section whose `resolution` is not exactly a sha512 integrity hash,
 * which pnpm fetches from the registry the checked settings pin to registry.npmjs.org. A `tarball`, `repo`,
 * `type` or `directory` field, a missing resolution or integrity, and any shape this check does not
 * recognise are all problems, as is a lockfile that has no `packages` section or does not parse as YAML.
 *
 * @example
 * nonRegistryResolutions("packages:\n  a@1.0.0:\n    resolution: {type: git, repo: https://x/y.git}\n");
 * // ['pnpm-lock.yaml: a@1.0.0 has resolution fields other than integrity: type, repo']
 */
export function nonRegistryResolutions(lockfile) {
  const { document, error } = parseLockfile(lockfile);
  if (error) return [`pnpm-lock.yaml ${error}`];
  if (!isPlainObject(document.packages)) {
    return ['pnpm-lock.yaml has no packages section this check can read'];
  }
  return Object.entries(document.packages).flatMap(([name, entry]) => resolutionProblems(name, entry));
}

function importerProblems(importers) {
  return Object.entries(importers).flatMap(([importer, sections]) =>
    PINNED_SECTIONS.flatMap((section) =>
      Object.entries(sections?.[section] ?? {})
        .filter(([, entry]) => {
          const version = isPlainObject(entry) ? entry.version : undefined;
          return !(
            typeof version === 'string' &&
            (EXACT_VERSION.test(withoutPeerSuffix(version)) || version.startsWith('link:../'))
          );
        })
        .map(
          ([name, entry]) =>
            `pnpm-lock.yaml: importers ${importer} ${section} ${name} resolves to ${asJson(entry?.version)}, not a registry version or a workspace link`,
        ),
    ),
  );
}

/**
 * Problems with the shape of pnpm-lock.yaml beyond the `packages` resolutions: a top-level key that changes
 * what is installed (`overrides`, `patchedDependencies`, `pnpmfileChecksum`, `packageExtensionsChecksum`), an
 * importer dependency that is neither a registry version nor a workspace link, and a snapshot with no
 * `packages` entry.
 *
 * @example
 * lockfileShapeProblems("pnpmfileChecksum: sha256-x\npackages: {}\n");
 * // ['pnpm-lock.yaml has pnpmfileChecksum, which changes what is installed; remove it']
 */
export function lockfileShapeProblems(lockfile) {
  const { document, error } = parseLockfile(lockfile);
  if (error) return [`pnpm-lock.yaml ${error}`];
  const forbidden = FORBIDDEN_LOCKFILE_KEYS.filter((key) => Object.hasOwn(document, key)).map(
    (key) => `pnpm-lock.yaml has ${key}, which changes what is installed; remove it`,
  );
  const packages = isPlainObject(document.packages) ? document.packages : {};
  const orphans = Object.keys(document.snapshots ?? {})
    .filter((key) => !Object.hasOwn(packages, withoutPeerSuffix(key)))
    .map((key) => `pnpm-lock.yaml: snapshot ${key} has no packages entry`);
  return [
    ...forbidden,
    ...importerProblems(isPlainObject(document.importers) ? document.importers : {}),
    ...orphans,
  ];
}

/**
 * The `name@version` of every package in the lockfile, and the directories of its importers (`.` for the
 * root, `packages/x` for the others).
 *
 * @example
 * lockfileInventory("importers:\n  .: {}\n  packages/a: {}\npackages:\n  b@1.0.0: {}\n");
 * // { specs: Set { 'b@1.0.0' }, importers: ['.', 'packages/a'] }
 */
export function lockfileInventory(lockfile) {
  const { document } = parseLockfile(lockfile);
  return {
    specs: new Set(isPlainObject(document?.packages) ? Object.keys(document.packages) : []),
    importers: isPlainObject(document?.importers) ? Object.keys(document.importers) : [],
  };
}

/**
 * The workspace package directories on disk: the root (`.`) plus each directory the `packages` globs of
 * `pnpm-workspace.yaml` match. Only plain directories and `dir/*` patterns are understood; any other glob
 * (a negation, `**`, a path with `..`) is a problem rather than a guess. `listPackageDirs(parent)` returns
 * the names of the directories under `parent` that hold a `package.json`; `isPackageDir(dir)` says whether
 * `dir` itself does.
 *
 * @example
 * workspacePackages(['packages/*'], (parent) => (parent === 'packages' ? ['a'] : []), () => false);
 * // { dirs: ['.', 'packages/a'], problems: [] }
 */
export function workspacePackages(globs, listPackageDirs, isPackageDir) {
  const problems = [];
  const dirs = ['.'];
  for (const glob of Array.isArray(globs) ? globs : []) {
    if (typeof glob !== 'string' || !WORKSPACE_GLOB.test(glob) || glob.split('/').includes('..')) {
      problems.push(
        `pnpm-workspace.yaml: packages entry ${asJson(glob)} is not a plain directory or a dir/* pattern`,
      );
    } else if (glob.endsWith('/*')) {
      dirs.push(...listPackageDirs(glob.slice(0, -2)).map((name) => `${glob.slice(0, -2)}/${name}`));
    } else if (isPackageDir(glob)) {
      dirs.push(glob);
    }
  }
  if (!Array.isArray(globs) || globs.length === 0) {
    problems.push('pnpm-workspace.yaml: packages must list the workspace package directories');
  }
  return { dirs: sortedUnique(dirs), problems };
}

/**
 * Differences between the workspace package directories on disk and the lockfile's `importers`, in both
 * directions. The lockfile can be edited in a pull request, so the packages checked come from the disk, and
 * an importer that is not on disk, or a package the lockfile does not list, is reported.
 *
 * @example
 * importerDifferences(['.', 'packages/a'], ['.']);
 * // ['packages/a is a workspace package but pnpm-lock.yaml has no importer for it']
 */
export function importerDifferences(dirs, importers) {
  return [
    ...dirs
      .filter((dir) => !importers.includes(dir))
      .map((dir) => `${dir} is a workspace package but pnpm-lock.yaml has no importer for it`),
    ...importers
      .filter((importer) => !dirs.includes(importer))
      .map((importer) => `pnpm-lock.yaml has an importer for ${importer}, which is not a workspace package`),
  ];
}

/**
 * The fields of `package.json` files that change what is installed (`overrides`, `resolutions`, `pnpm`).
 * Each is a problem, since the pins and the lockfile checks do not see through them.
 *
 * @example
 * manifestFieldProblems([{ file: 'package.json', json: { overrides: { a: '1.0.0' } } }]);
 * // ['package.json: overrides changes what is installed; remove it']
 */
export function manifestFieldProblems(manifests) {
  return manifests.flatMap(({ file, json }) =>
    FORBIDDEN_MANIFEST_FIELDS.filter((field) => Object.hasOwn(json, field)).map(
      (field) => `${file}: ${field} changes what is installed; remove it`,
    ),
  );
}

/**
 * A pnpmfile (`.pnpmfile.mjs` or `.pnpmfile.cjs`) in the root or in a workspace package directory: pnpm
 * loads it by default and runs its hooks on every install, before this check can run, whatever
 * `--ignore-scripts` says. `dirs` are the workspace directories (`.` for the root).
 *
 * @example
 * pnpmfileProblems(['.', 'packages/a'], (file) => file === 'packages/a/.pnpmfile.cjs');
 * // ['packages/a/.pnpmfile.cjs exists; pnpm runs it on install, before this check']
 */
export function pnpmfileProblems(dirs, exists) {
  return dirs
    .flatMap((dir) => PNPMFILES.map((file) => (dir === '.' ? file : `${dir}/${file}`)))
    .filter((file) => exists(file))
    .map((file) => `${file} exists; pnpm runs it on install, before this check`);
}

function codeownersPatternToRegExp(pattern) {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const body = pattern.replace(/^\//, '').replace(/\/$/, '');
  const source = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '@@ANY_DIRS@@')
    .replace(/\/\*\*/g, '@@ANY_TAIL@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/@@ANY_DIRS@@/g, '(?:.*/)?')
    .replace(/@@ANY_TAIL@@/g, '/.*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}(?:/.*)?$`);
}

const hasOwner = (owners) => owners.some((owner) => owner.startsWith('@') || /^[^@\s]+@[^@\s]+$/.test(owner));

const PNPM_HARDENING_ENV = {
  pnpm_config_ignore_pnpmfile: 'true',
  pnpm_config_verify_deps_before_run: 'false',
};

const PNPM_CONFIG_ENV = /^(?:pnpm|npm)_config_/i;
const ALLOWED_ACTIONS = [
  'actions/checkout',
  'actions/setup-node',
  'pnpm/action-setup',
  'actions/dependency-review-action',
];
const PINNED_ACTION = /^([\w.-]+\/[\w.-]+)@[0-9a-f]{40}$/;

const envOf = (holder) => (isPlainObject(holder?.env) ? holder.env : {});

function stepProblems(jobName, step, index, inherited) {
  const where = `workflow job ${jobName} step ${index + 1}`;
  const effective = { ...inherited, ...envOf(step) };
  const stray = Object.keys(envOf(step))
    .filter((key) => PNPM_CONFIG_ENV.test(key) && !Object.hasOwn(PNPM_HARDENING_ENV, key))
    .map((key) => `${where} env sets ${key}, which is not on the allow-list`);
  const unhardened = /\bpnpm\b/.test(step?.run ?? '')
    ? Object.entries(PNPM_HARDENING_ENV)
        .filter(([key, value]) => effective[key] !== value)
        .map(([key, value]) => `${where} runs pnpm but its effective env ${key} is not '${value}'`)
    : [];
  const action = typeof step?.uses === 'string' ? PINNED_ACTION.exec(step.uses)?.[1] : undefined;
  const unpinned =
    step?.uses !== undefined && !ALLOWED_ACTIONS.includes(action)
      ? [`${where} uses ${step.uses}, which is not an allowed action pinned to a full commit SHA`]
      : [];
  return [...stray, ...unhardened, ...unpinned];
}

function jobProblems(name, job, workflowEnv) {
  if (typeof job?.uses === 'string') {
    return [`workflow job ${name} calls the reusable workflow ${job.uses}, which this check cannot read`];
  }
  const inherited = { ...workflowEnv, ...envOf(job) };
  const stray = Object.keys(envOf(job))
    .filter((key) => PNPM_CONFIG_ENV.test(key) && !Object.hasOwn(PNPM_HARDENING_ENV, key))
    .map((key) => `workflow job ${name} env sets ${key}, which is not on the allow-list`);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return [...stray, ...steps.flatMap((step, index) => stepProblems(name, step, index, inherited))];
}

/**
 * Problems in a workflow that let pnpm load a pnpmfile or re-run install with its lifecycle scripts, or that
 * run code this check does not know. For each step that runs `pnpm`, the effective env (workflow, then job,
 * then step) must hold both hardening variables (`--ignore-pnpmfile` is rejected by `pnpm run` and
 * `pnpm config`, so env is the only way). Any other `pnpm_config_*` or `npm_config_*` key in an env, any job
 * that calls a reusable workflow, and any `uses:` step that is not one of the four allowed actions pinned
 * to a full 40-hex commit SHA is a problem.
 *
 * @example
 * workflowProblems('jobs:\n  a:\n    steps:\n      - run: pnpm audit\n');
 * // ["workflow job a step 1 runs pnpm but its effective env pnpm_config_ignore_pnpmfile is not 'true'", …]
 */
export function workflowProblems(text) {
  const workflow = YAML.parse(text);
  if (!isPlainObject(workflow?.jobs)) return ['workflow has no jobs this check can read'];
  const workflowEnv = envOf(workflow);
  const stray = Object.keys(workflowEnv)
    .filter((key) => PNPM_CONFIG_ENV.test(key) && !Object.hasOwn(PNPM_HARDENING_ENV, key))
    .map((key) => `workflow env sets ${key}, which is not on the allow-list`);
  return [
    ...stray,
    ...Object.entries(workflow.jobs).flatMap(([name, job]) => jobProblems(name, job, workflowEnv)),
  ];
}

/**
 * Whether `.github/CODEOWNERS` is present, has no rule without an owner (which would un-own whatever it
 * matches), and gives an owner to each path that decides what is installed or how it is checked, judged as
 * GitHub does: the last rule whose pattern matches the path wins. `text` is the file's content, or
 * `undefined` when it does not exist. Branch protection must also require code-owner review; that is a
 * repository setting this check cannot see.
 *
 * @example
 * codeownersProblems(undefined); // ['.github/CODEOWNERS is missing']
 */
export function codeownersProblems(text) {
  if (text === undefined) return ['.github/CODEOWNERS is missing'];
  const rules = text
    .split('\n')
    .map((line, index) => ({ line: index + 1, tokens: line.trim().split(/\s+/) }))
    .filter(({ tokens }) => tokens[0] !== '' && !tokens[0].startsWith('#'))
    .map(({ line, tokens }) => ({
      line,
      pattern: tokens[0],
      owners: tokens.slice(1),
      matches: codeownersPatternToRegExp(tokens[0]),
    }));
  const ownerless = rules
    .filter(({ owners }) => !hasOwner(owners))
    .map(
      ({ line, pattern }) =>
        `.github/CODEOWNERS line ${line}: ${pattern} has no owner, which removes ownership from what it matches`,
    );
  const unowned = CODEOWNER_PROTECTED_PATHS.filter(
    (path) => !hasOwner(rules.findLast(({ matches }) => matches.test(path))?.owners ?? []),
  ).map((path) => `.github/CODEOWNERS: ${path} has no code owner`);
  return [...ownerless, ...unowned];
}

/**
 * For a release (`--release`, or CI): the `@OWNER` placeholder left in `.github/CODEOWNERS`, which would
 * leave the protected paths with no real reviewer.
 *
 * @example
 * placeholderOwnerProblems('/pnpm-lock.yaml @OWNER\n');
 * // ['.github/CODEOWNERS still names the placeholder @OWNER; replace it with …']
 */
export function placeholderOwnerProblems(text) {
  return text?.split(/\s+/).includes(OWNER_PLACEHOLDER)
    ? [
        `.github/CODEOWNERS still names the placeholder ${OWNER_PLACEHOLDER}; replace it with the maintainers GitHub user or team`,
      ]
    : [];
}

/**
 * The required security settings that `pnpm-workspace.yaml` lacks or weakens. `settings` maps each setting
 * name to its value in the file; `allowBuilds` may only refuse builds (every value `false`), and
 * `minimumReleaseAge` must be a number.
 *
 * @example
 * settingProblems({ saveExact: true });
 * // ['pnpm-workspace.yaml: minimumReleaseAge must be a number of at least 10080 (7 days)', …]
 */
export function settingProblems(settings) {
  return Object.entries(REQUIRED_SETTINGS)
    .filter(([key, accepts]) => !accepts(settings[key]))
    .map(([key]) =>
      key === 'minimumReleaseAge'
        ? `pnpm-workspace.yaml: minimumReleaseAge must be a number of at least ${MIN_RELEASE_AGE_MINUTES} (7 days)`
        : `pnpm-workspace.yaml: ${key} is missing or weakened`,
    );
}

const sortedUnique = (values) => [...new Set(values)].sort();

function isRealDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function latestExpiry(today) {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MAX_EXCEPTION_DAYS);
  return limit.toISOString().slice(0, 10);
}

function expiryProblems(label, expires, today) {
  if (typeof expires !== 'string' || !isRealDate(expires)) {
    return [`${label} needs an expires date as a real YYYY-MM-DD`];
  }
  if (expires < today) return [`${label} expired on ${expires}; remove it`];
  if (expires > latestExpiry(today)) {
    return [`${label} expires on ${expires}, more than ${MAX_EXCEPTION_DAYS} days after ${today}`];
  }
  return [];
}

function exceptionEntryProblems(entry, today, lockedSpecs) {
  if (!isPlainObject(entry)) return [`supply-chain-exceptions.json: entry ${asJson(entry)} is not an object`];
  const label = `supply-chain-exceptions.json: ${entry.spec}`;
  const problems = [];
  if (typeof entry.spec !== 'string' || !EXACT_SPEC.test(entry.spec)) {
    problems.push(`${label} is not an exact name@version`);
  } else if (!lockedSpecs.has(entry.spec)) {
    problems.push(`${label} is not in pnpm-lock.yaml; remove it`);
  }
  if (!Object.hasOwn(EXCEPTION_KINDS, entry.kind)) problems.push(`${label} has kind "${entry.kind}"`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') problems.push(`${label} has no reason`);
  if (entry.kind === 'release-age') problems.push(...expiryProblems(label, entry.expires, today));
  return problems;
}

function listDifference(kind, reported, entries) {
  if (
    reported !== undefined &&
    !(Array.isArray(reported) && reported.every((spec) => typeof spec === 'string'))
  ) {
    return [`pnpm-workspace.yaml: ${EXCEPTION_KINDS[kind]} is not a list of name@version strings`];
  }
  const wanted = sortedUnique(
    entries
      .filter((entry) => entry?.kind === kind && typeof entry.spec === 'string')
      .map((entry) => entry.spec),
  );
  const actual = sortedUnique(reported ?? []);
  const bad = actual
    .filter((spec) => !EXACT_SPEC.test(spec))
    .map(
      (spec) => `pnpm-workspace.yaml: ${EXCEPTION_KINDS[kind]} entry ${spec} is not an exact name@version`,
    );
  const unlisted = actual
    .filter((spec) => !wanted.includes(spec))
    .map(
      (spec) =>
        `${EXCEPTION_KINDS[kind]} has ${spec} in pnpm-workspace.yaml but not in supply-chain-exceptions.json`,
    );
  const unapplied = wanted
    .filter((spec) => !actual.includes(spec))
    .map(
      (spec) =>
        `${spec} is in supply-chain-exceptions.json but not in ${EXCEPTION_KINDS[kind]} in pnpm-workspace.yaml`,
    );
  return [...bad, ...unlisted, ...unapplied];
}

/**
 * Problems with the exact-version exceptions: a file that is not a list, an entry that is not an object, is
 * not `name@version`, is not in the lockfile (a stale exception), has no reason or an unknown kind, or is a
 * release-age entry whose `expires` is not a real date, is past, or is more than 7 days after `today`; plus
 * any difference, in either direction, between the file and the exclude lists in `settings` (the workspace
 * file's). Works offline; `today` is an ISO date (YYYY-MM-DD) passed in so callers can fix it, and
 * `lockedSpecs` is the set of `name@version` in pnpm-lock.yaml.
 *
 * @example
 * exceptionProblems([], { trustPolicyExclude: ['semver@6.3.1'] }, '2026-10-23', new Set());
 * // ['trustPolicyExclude has semver@6.3.1 in pnpm-workspace.yaml but not in supply-chain-exceptions.json']
 */
export function exceptionProblems(entries, settings, today, lockedSpecs) {
  if (!Array.isArray(entries)) return ['supply-chain-exceptions.json must be a list of entries'];
  return [
    ...entries.flatMap((entry) => exceptionEntryProblems(entry, today, lockedSpecs)),
    ...Object.entries(EXCEPTION_KINDS).flatMap(([kind, listName]) =>
      listDifference(kind, settings[listName], entries),
    ),
  ];
}

const listDirs = (parent) =>
  existsSync(new URL(`${parent}/`, ROOT))
    ? readdirSync(new URL(`${parent}/`, ROOT), { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(new URL(`${parent}/${entry.name}/package.json`, ROOT)),
        )
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * Runs every check against the repository and returns the problems found, empty when the repo is clean.
 * `readEffective` returns what `effectiveSettings` does. With `release` set, a `CODEOWNERS` that still names
 * the `@OWNER` placeholder is a problem too.
 *
 * @example
 * collectProblems('2026-10-23', effectiveSettings, { release: false }); // []
 */
export function collectProblems(today, readEffective, { release = false } = {}) {
  const readIfPresent = (file) =>
    existsSync(new URL(file, ROOT)) ? readFileSync(new URL(file, ROOT), 'utf8') : undefined;
  const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');
  const lockfile = read('pnpm-lock.yaml');
  const { specs, importers } = lockfileInventory(lockfile);
  const settings = workspaceSettings(read('pnpm-workspace.yaml'));
  const workspace = workspacePackages(settings.packages, listDirs, (dir) =>
    existsSync(new URL(`${dir}/package.json`, ROOT)),
  );
  const manifests = workspace.dirs.map((dir) => {
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    return { file, json: JSON.parse(read(file)) };
  });
  let entries;
  try {
    entries = JSON.parse(read('supply-chain-exceptions.json'));
  } catch (error) {
    entries = { unreadable: error.message };
  }
  const codeowners = readIfPresent('.github/CODEOWNERS');
  return [
    ...workspace.problems,
    ...importerDifferences(workspace.dirs, importers),
    ...unpinnedDependencies(manifests),
    ...manifestFieldProblems(manifests),
    ...nonRegistryResolutions(lockfile),
    ...lockfileShapeProblems(lockfile),
    ...pnpmfileProblems(workspace.dirs, (file) => existsSync(new URL(file, ROOT))),
    ...codeownersProblems(codeowners),
    ...(release ? placeholderOwnerProblems(codeowners) : []),
    ...workflowProblems(read('.github/workflows/security.yml')),
    ...unexpectedWorkspaceKeys(settings),
    ...settingProblems(settings),
    ...effectiveProblems(settings, readEffective()),
    ...exceptionProblems(entries, settings, today, specs),
  ];
}

function main() {
  try {
    const release = process.argv.includes('--release') || process.env.CI === 'true';
    const today = new Date().toISOString().slice(0, 10);
    const problems = collectProblems(today, effectiveSettings, { release });
    for (const problem of problems) console.error(problem);
    return problems.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`supply-chain check could not run: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
