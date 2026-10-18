import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pattern list never lives in this repo: it comes from FORBIDDEN_PATTERNS (comma-separated)
// or the git-ignored internal/forbidden-patterns.txt (one per line, `#` comments).
const SKIP_DIRS = new Set(['internal', 'node_modules', 'dist', '.git', '.superpowers']);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export async function scan(rootDir, patterns) {
  const needles = patterns.map((p) => p.toLowerCase());
  const hits = [];
  for await (const file of walk(rootDir)) {
    const buf = await readFile(file);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    buf
      .toString('utf8')
      .toLowerCase()
      .split('\n')
      .forEach((text, i) => {
        for (const pattern of needles) {
          if (text.includes(pattern)) hits.push({ file, line: i + 1, pattern });
        }
      });
  }
  return hits;
}

async function loadPatterns(root) {
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

// realpath: argv[1] may go through a symlink (e.g. macOS /var -> /private/var) while import.meta.url does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const patterns = await loadPatterns(root);
  if (patterns.length === 0) {
    console.error('forbidden-strings: no pattern list (set FORBIDDEN_PATTERNS or create internal/forbidden-patterns.txt)');
    process.exit(2);
  }
  const hits = await scan(root, patterns);
  for (const h of hits) console.log(`${path.relative(root, h.file)}:${h.line} ${h.pattern}`);
  process.exit(hits.length ? 1 : 0);
}
