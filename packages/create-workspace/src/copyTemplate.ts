import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The starters this package can generate.
 *
 * @example
 * const choices = TEMPLATE_NAMES.join(', ');
 */
export const TEMPLATE_NAMES = ['next', 'vite'] as const;

/**
 * One of {@link TEMPLATE_NAMES}.
 *
 * @example
 * const template: TemplateName = 'next';
 */
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * Input of {@link createWorkspace}.
 *
 * @example
 * const options: CreateWorkspaceOptions = { template: 'next', directory: 'my-files', versions: {} };
 */
export interface CreateWorkspaceOptions {
  template: TemplateName;
  directory: string;
  /** Exact version for every `@workspacekit/*` package a template depends on, keyed by package name. */
  versions: Record<string, string>;
  /** Packages that are `private`; a template depending on one is refused. */
  privatePackages?: readonly string[];
}

const TEMPLATES_ROOT = new URL('../templates/', import.meta.url);
const WORKSPACE_RANGE = 'workspace:*';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;

type DependencyMap = Record<string, string>;
type PackageJson = { name: string } & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], DependencyMap>>;

function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

async function isNonEmptyDirectory(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return false;
    if (code === 'ENOTDIR') {
      throw new Error(`"${directory}" is a file, not a directory. Choose a new directory name.`, {
        cause: error,
      });
    }
    throw error;
  }
}

const PACKED_GITIGNORE_NAME = '_gitignore';
const GITIGNORE_NAME = '.gitignore';
const UNPUBLISHED_VERSION = '0.0.0';

function pinWorkspaceRanges(
  dependencies: DependencyMap,
  versions: Record<string, string>,
  privatePackages: readonly string[],
): string[] {
  const unpublished: string[] = [];
  for (const [name, range] of Object.entries(dependencies)) {
    if (range !== WORKSPACE_RANGE) continue;
    const version = versions[name];
    if (version === undefined) {
      throw new Error(
        `No version was given for ${name}. Pass it in "versions", for example { "${name}": "1.0.0" }.`,
      );
    }
    if (version === UNPUBLISHED_VERSION || privatePackages.includes(name)) unpublished.push(name);
    dependencies[name] = version;
  }
  return unpublished;
}

function projectNameFor(directory: string): string {
  const slug = path
    .basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return slug.replace(/^[._-]+/, '') || 'file-workspace';
}

/**
 * Copies a starter into `directory` and pins every `@workspacekit/*` dependency to an exact version.
 *
 * Refuses a directory that already has files, and an unknown template, with a message that says what to
 * change.
 *
 * @example
 * const versions = { '@workspacekit/core': '1.0.0' };
 * await createWorkspace({ template: 'vite', directory: 'my-files', versions });
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<void> {
  const { template, versions } = options;
  if (!isTemplateName(template)) {
    throw new Error(`Unknown template "${String(template)}". Use one of: ${TEMPLATE_NAMES.join(', ')}.`);
  }
  const directory = path.resolve(options.directory);
  if (await isNonEmptyDirectory(directory)) {
    throw new Error(`Directory "${directory}" is not empty. Choose a new directory or empty this one first.`);
  }
  const source = new URL(`${template}/`, TEMPLATES_ROOT);
  const packageJson = JSON.parse(await readFile(new URL('package.json', source), 'utf8')) as PackageJson;
  const unpublished = DEPENDENCY_FIELDS.flatMap((field) =>
    pinWorkspaceRanges(packageJson[field] ?? {}, versions, options.privatePackages ?? []),
  );
  if (unpublished.length > 0) {
    throw new Error(
      `These packages are not published yet: ${unpublished.join(', ')}. The starter works once they are released.`,
    );
  }
  packageJson.name = projectNameFor(directory);
  await mkdir(directory, { recursive: true });
  await cp(source, directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await rename(path.join(directory, PACKED_GITIGNORE_NAME), path.join(directory, GITIGNORE_NAME));
}
