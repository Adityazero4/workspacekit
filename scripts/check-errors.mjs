import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headingSlugs } from '../apps/docs/scripts/check-content.mjs';

const THROW_START = /throw new (?:Type)?Error\(/g;
const DOCS_LINK_CALL = /docsLink\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?\s*\)/g;
const QUOTES = new Set(["'", '"', '`']);

/**
 * Throws that are not developer misconfiguration, so they carry no docs link. Each names the file, a piece of
 * its message, and why the message stays as it is.
 */
export const ALLOWED_THROWS = [
  {
    file: 'packages/create-workspace/src/copyTemplate.ts',
    message: 'is a file, not a directory',
    reason: 'a terminal message to the person running the scaffolder, already saying what to do',
  },
  {
    file: 'packages/create-workspace/src/copyTemplate.ts',
    message: 'No version was given for',
    reason: 'the scaffolder is called by its own bin, which always passes the versions',
  },
  {
    file: 'packages/create-workspace/src/copyTemplate.ts',
    message: 'Unknown template',
    reason: 'a terminal message that lists the valid template names',
  },
  {
    file: 'packages/create-workspace/src/copyTemplate.ts',
    message: 'is not empty',
    reason: 'a terminal message to the person running the scaffolder, already saying what to do',
  },
  {
    file: 'packages/create-workspace/src/copyTemplate.ts',
    message: 'are not published yet',
    reason: 'a terminal message about release state, not something an integrator configures',
  },
  {
    file: 'packages/docx/src/limits.ts',
    message: 'A part declares a document type',
    reason: 'a rejection of an untrusted file, shown in the viewer',
  },
  {
    file: 'packages/pptx/src/limits.ts',
    message: 'Not a zip archive',
    reason: 'a rejection of an untrusted file, shown in the viewer',
  },
  {
    file: 'packages/pptx/src/limits.ts',
    message: 'ZIP64 archives are not read',
    reason: 'a rejection of an untrusted file, shown in the viewer',
  },
  {
    file: 'packages/pptx/src/limits.ts',
    message: 'Corrupted zip archive',
    reason: 'a rejection of an untrusted file, shown in the viewer',
  },
  {
    file: 'packages/pptx/src/limits.ts',
    message: 'A part declares a document type',
    reason: 'a rejection of an untrusted file, shown in the viewer',
  },
  {
    file: 'packages/react/src/renderers/standalone.ts',
    message: 'answered ${response.status}',
    reason: 'a network failure for the file being viewed, shown in the viewer',
  },
  {
    file: 'packages/react/src/renderers/tiff/decodeTiff.ts',
    message: 'The browser gave no 2D canvas',
    reason: 'a decode failure shown in the viewer',
  },
  {
    file: 'packages/react/src/renderers/tiff/decodeTiff.ts',
    message: 'This TIFF has no image pages',
    reason: 'a decode failure shown in the viewer',
  },
  {
    file: 'packages/react/src/renderers/tiff/pageCache.ts',
    message: 'scrolled away before its turn',
    reason: 'control flow: cancels a page render the user scrolled past',
  },
];

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function statementEnd(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];
    if (QUOTES.has(character)) {
      index = closingQuote(text, index);
    } else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index + 1;
  }
  return text.length;
}

function closingQuote(text, openIndex) {
  const quote = text[openIndex];
  for (let index = openIndex + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === quote) return index;
  }
  return text.length;
}

function throwsIn({ path: file, text }) {
  return [...text.matchAll(THROW_START)].map((match) => ({
    file,
    line: lineOf(text, match.index),
    statement: text.slice(match.index, statementEnd(text, match.index + match[0].length - 1)),
  }));
}

function docsLinkProblems({ path: file, text }, docs) {
  return [...text.matchAll(DOCS_LINK_CALL)].flatMap((match) => {
    const [, page, anchor] = match;
    const where = `${file}:${lineOf(text, match.index)}`;
    const pageText = docs.get(page);
    if (pageText === undefined) {
      return [`${where} docsLink page "${page}" does not exist under apps/docs/content/docs`];
    }
    if (anchor !== undefined && !headingSlugs(pageText).has(anchor)) {
      return [`${where} docsLink anchor "${anchor}" is not a heading of "${page}"`];
    }
    return [];
  });
}

/**
 * What is wrong with the errors in the given source files: a throw with no `docsLink(...)` that is not on the
 * allow-list, an allow-list entry that matches nothing, and a `docsLink` page or anchor missing from the
 * docs. `docs` maps a page such as `server/handler` to its text.
 *
 * @example
 * const problems = errorProblems({ sources: [], docs: new Map(), allowList: [] });
 */
export function errorProblems({ sources, docs, allowList }) {
  const checked = sources.filter(({ path: file }) => !/\.test\.[cm]?[jt]sx?$/.test(file));
  const throws = checked.flatMap(throwsIn);
  const used = new Set();
  const problems = [];
  for (const thrown of throws) {
    const entry = allowList.find(
      ({ file, message }) => file === thrown.file && thrown.statement.includes(message),
    );
    if (entry) used.add(entry);
    else if (!thrown.statement.includes('docsLink(')) {
      problems.push(
        `${thrown.file}:${thrown.line} throw has no docsLink(...); add one or allow-list it in scripts/check-errors.mjs with a reason`,
      );
    }
  }
  for (const entry of allowList.filter((candidate) => !used.has(candidate))) {
    problems.push(`allow-list entry for ${entry.file} matches no throw: "${entry.message}"`);
  }
  return [...problems, ...checked.flatMap((source) => docsLinkProblems(source, docs))];
}

function filesUnder(folder, extensions) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
  });
}

function loadSources(root) {
  return readdirSync(path.join(root, 'packages')).flatMap((packageName) => {
    const folder = path.join(root, 'packages', packageName, 'src');
    return filesUnder(folder, ['.ts', '.tsx']).map((full) => ({
      path: path.relative(root, full).split(path.sep).join('/'),
      text: readFileSync(full, 'utf8'),
    }));
  });
}

function loadDocs(root) {
  const folder = path.join(root, 'apps', 'docs', 'content', 'docs');
  const docs = new Map();
  for (const full of filesUnder(folder, ['.mdx'])) {
    const page = path
      .relative(folder, full)
      .split(path.sep)
      .join('/')
      .replace(/\.mdx$/, '');
    docs.set(page.replace(/\/index$/, ''), readFileSync(full, 'utf8'));
  }
  return docs;
}

const invokedPathWithSymlinksResolved = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPathWithSymlinksResolved === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = errorProblems({
    sources: loadSources(root),
    docs: loadDocs(root),
    allowList: ALLOWED_THROWS,
  });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check-errors: ${problems.length} problem(s) in developer errors`);
    process.exit(1);
  }
}
