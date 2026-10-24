import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportedNamesOf, PUBLIC_PACKAGES } from './agent-docs.mjs';

const SNAPSHOT_FOLDER = 'api';
const REGENERATE_HINT = 'Run pnpm api, review the diff, and commit it.';

/**
 * Names that are deliberately not public API, by entry. A snapshot or a build that lists one fails the
 * check; monorepo code that needs one imports it from the defining package's source path.
 *
 * @example
 * const isInternal = INTERNAL_NAMES['@workspacekit/core'].includes('applyBatch');
 */
export const INTERNAL_NAMES = {
  '@workspacekit/core': [
    'applyBatch',
    'compareEntries',
    'depthOf',
    'emptyTree',
    'flattenVisible',
    'kindForStatus',
    'mergeListing',
    'moveSubtree',
    'removeSubtree',
    'resolveUnder',
    'shouldSkipPath',
    'TreeOp',
    'upsertEntry',
  ],
  '@workspacekit/core/memory': ['generateShape', 'generateTree', 'TreeShape'],
};

const snapshotPath = (root, folderName) => path.join(root, SNAPSHOT_FOLDER, `${folderName}.txt`);

async function missingTypesFiles(root, folderName) {
  const folder = path.join(root, 'packages', folderName);
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  return Object.values(manifest.exports)
    .filter((target) => typeof target === 'object' && target.types)
    .map((target) => path.join(folder, target.types))
    .filter((typesFile) => !existsSync(typesFile))
    .map((typesFile) => path.relative(root, typesFile));
}

const buildFirst = (folderName, missing) =>
  `${folderName}: the types file ${missing.join(', ')} is missing. Build the package first.`;

async function currentLines(root, folderName) {
  const missing = await missingTypesFiles(root, folderName);
  if (missing.length > 0) throw new Error(buildFirst(folderName, missing));
  const entries = await exportedNamesOf(root, folderName);
  return entries.flatMap(({ specifier, names }) => names.map((name) => `${specifier} ${name}`)).sort();
}

const linesOf = (text) => text.split('\n').filter(Boolean);

function internalLines(lines) {
  return lines.filter((line) => {
    const [entry, name] = line.split(' ');
    return INTERNAL_NAMES[entry]?.includes(name);
  });
}

function listProblem(label, folderName, lines) {
  return `${folderName}: ${label} in the public API:\n${lines.map((line) => `  ${line}`).join('\n')}\n${REGENERATE_HINT}`;
}

async function problemsOf(root, folderName) {
  const missing = await missingTypesFiles(root, folderName);
  if (missing.length > 0) return [buildFirst(folderName, missing)];
  const file = snapshotPath(root, folderName);
  if (!existsSync(file)) {
    return [`api/${folderName}.txt is missing. ${REGENERATE_HINT}`];
  }
  const snapshot = linesOf(await readFile(file, 'utf8'));
  const current = await currentLines(root, folderName);
  const problems = [];
  const added = current.filter((line) => !snapshot.includes(line));
  const removed = snapshot.filter((line) => !current.includes(line));
  if (added.length > 0) problems.push(listProblem('added', folderName, added));
  if (removed.length > 0) problems.push(listProblem('removed', folderName, removed));
  const internal = internalLines([...new Set([...snapshot, ...current])]);
  if (internal.length > 0) {
    problems.push(
      `${folderName}: internal names are not allowed in the public API:\n${internal.map((line) => `  ${line}`).join('\n')}`,
    );
  }
  return problems;
}

/**
 * Writes `api/<package>.txt` for each package: one `<entry> <name>` line per public export, sorted, read
 * from the built type declarations. Build the packages first.
 *
 * @example
 * await writeApiSnapshots({ root: process.cwd(), packages: ['core'] });
 */
export async function writeApiSnapshots({ root, packages }) {
  await mkdir(path.join(root, SNAPSHOT_FOLDER), { recursive: true });
  for (const folderName of packages) {
    const lines = await currentLines(root, folderName);
    await writeFile(snapshotPath(root, folderName), `${lines.join('\n')}\n`);
  }
}

/**
 * Compares each package's built public exports with its committed snapshot and returns one problem per
 * added names, removed names, missing snapshot, or internal name. An empty list means the API is frozen.
 *
 * @example
 * const problems = await checkApi({ root: process.cwd(), packages: ['core'] });
 */
export async function checkApi({ root, packages }) {
  const problems = [];
  for (const folderName of packages) {
    problems.push(...(await problemsOf(root, folderName)));
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--write')) {
    await writeApiSnapshots({ root, packages: PUBLIC_PACKAGES });
  } else {
    const problems = await checkApi({ root, packages: PUBLIC_PACKAGES });
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.error(`check-api: ${problems.length} problem(s).`);
      process.exit(1);
    }
  }
}
