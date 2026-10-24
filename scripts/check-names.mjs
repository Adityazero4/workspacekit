import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RETIRED_NAMES = ['@scope/', '@scope\\/', 'docs.example.invalid'];
const HISTORY_FOLDERS = ['internal/', '.superpowers/'];
const SELF = 'scripts/check-names';

/**
 * Lines in the given files that still carry a retired placeholder name: the old `@scope/` package scope or
 * the `docs.example.invalid` docs domain. Files under `internal/` (plans and ledgers, which record history)
 * and this check's own files are skipped.
 *
 * @example
 * const problems = nameProblems([{ path: 'README.md', text: 'npm install @scope/core' }]);
 */
export function nameProblems(files) {
  return files
    .filter(({ path: file }) => !HISTORY_FOLDERS.some((folder) => file.startsWith(folder)))
    .filter(({ path: file }) => !file.startsWith(SELF))
    .flatMap(({ path: file, text }) =>
      text
        .split('\n')
        .flatMap((line, index) =>
          RETIRED_NAMES.filter((name) => line.includes(name)).map((name) => `${file}:${index + 1} ${name}`),
        ),
    );
}

function trackedTextFiles(root) {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return listed
    .split('\0')
    .filter(Boolean)
    .flatMap((file) => {
      const content = readFileSync(path.join(root, file));
      return content.subarray(0, 8000).includes(0) ? [] : [{ path: file, text: content.toString('utf8') }];
    });
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = nameProblems(trackedTextFiles(root));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `check-names: ${problems.length} placeholder name(s) left; use @workspacekit/ and the real docs URL`,
    );
    process.exit(1);
  }
}
