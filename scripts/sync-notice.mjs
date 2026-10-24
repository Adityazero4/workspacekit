import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGES } from './agent-docs.mjs';

const SHARED_FILES = ['NOTICE', 'LICENSE'];

/**
 * The shared legal files (`NOTICE`, `LICENSE`) that a package folder is missing or holds a different copy
 * of. npm packs these only from the package folder, so each public package keeps a committed copy.
 *
 * @example
 * const stale = staleLegalFiles('.', ['core']);
 */
export function staleLegalFiles(root, packages) {
  return packages.flatMap((folder) =>
    SHARED_FILES.flatMap((name) => {
      const copy = path.join(root, 'packages', folder, name);
      const same =
        existsSync(copy) && readFileSync(copy, 'utf8') === readFileSync(path.join(root, name), 'utf8');
      return same ? [] : [`packages/${folder}/${name}`];
    }),
  );
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--write')) {
    for (const folder of PUBLIC_PACKAGES) {
      for (const name of SHARED_FILES) {
        copyFileSync(path.join(root, name), path.join(root, 'packages', folder, name));
      }
    }
  } else {
    const stale = staleLegalFiles(root, PUBLIC_PACKAGES);
    for (const file of stale) console.error(file);
    if (stale.length > 0) {
      console.error('sync-notice: missing or stale copies; run `node scripts/sync-notice.mjs --write`');
      process.exit(1);
    }
  }
}
