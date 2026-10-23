import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['internal', 'node_modules', 'dist', '.git', '.superpowers']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export async function scan(rootDir, patterns) {
  const needles = patterns.map((pattern) => pattern.toLowerCase());
  const hits = [];
  for await (const file of walk(rootDir)) {
    const content = await readFile(file);
    const looksBinary = content.subarray(0, 8000).includes(0);
    if (looksBinary) continue;
    content
      .toString('utf8')
      .toLowerCase()
      .split('\n')
      .forEach((text, lineIndex) => {
        for (const pattern of needles) {
          if (text.includes(pattern)) hits.push({ file, line: lineIndex + 1, pattern });
        }
      });
  }
  return hits;
}

/**
 * The forbidden patterns, which never live in this repo: `FORBIDDEN_PATTERNS` (comma-separated) or the
 * git-ignored `internal/forbidden-patterns.txt` (one per line, `#` comments).
 *
 * @example
 * const patterns = await loadPatterns(repoRoot);
 */
export async function loadPatterns(root) {
  const env = process.env.FORBIDDEN_PATTERNS;
  let lines;
  if (env?.trim()) {
    lines = env.split(',');
  } else {
    try {
      lines = (await readFile(path.join(root, 'internal', 'forbidden-patterns.txt'), 'utf8'))
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'));
    } catch {
      return [];
    }
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const patterns = await loadPatterns(root);
  if (patterns.length === 0 && process.env.CI !== 'true') {
    console.warn(
      'forbidden-strings: skipped, no pattern list (maintainers set FORBIDDEN_PATTERNS or create internal/forbidden-patterns.txt; CI requires one)',
    );
    process.exit(0);
  }
  if (patterns.length === 0) {
    console.error(
      'forbidden-strings: no pattern list (set FORBIDDEN_PATTERNS or create internal/forbidden-patterns.txt)',
    );
    process.exit(2);
  }
  const hits = await scan(root, patterns);
  for (const hit of hits) {
    process.stdout.write(`${path.relative(root, hit.file)}:${hit.line} ${hit.pattern}\n`);
  }
  process.exit(hits.length ? 1 : 0);
}
