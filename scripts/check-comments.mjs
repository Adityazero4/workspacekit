import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MAX_JSDOC_LINE_LENGTH = 110;
const MACHINE_DIRECTIVE =
  /^(\/\/\/\s*<reference\b|\/[/*]\s*(eslint-(disable|enable)|@ts-expect-error|@ts-ignore)\b)/;
const MEMBER_KINDS = new Set([
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.EnumMember,
]);
const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ModuleDeclaration,
]);

async function* filesUnder(dir, accept) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      yield* filesUnder(full, accept);
    } else if (entry.isFile() && accept(entry.name)) {
      yield full;
    }
  }
}

function scriptKindOf(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function allCommentRanges(sourceFile) {
  const text = sourceFile.text;
  const byStart = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) byStart.set(range.pos, range);
  };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return [...byStart.values()];
}

function hasExportModifier(statement) {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function locallyReExportedNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  }
  return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
}

function exportedDeclarations(sourceFile) {
  const reExported = locallyReExportedNames(sourceFile);
  return sourceFile.statements.filter(
    (statement) =>
      ts.isExportAssignment(statement) ||
      (DECLARATION_KINDS.has(statement.kind) &&
        (hasExportModifier(statement) || declaredNames(statement).some((name) => reExported.has(name)))),
  );
}

function jsDocsOf(node) {
  return node.jsDoc ?? [];
}

function topLevelStatementOf(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    if (ts.isBlock(current.parent)) return undefined;
    current = current.parent;
  }
  return current;
}

function isPrivateClassMember(node) {
  if (!node.parent || !ts.isClassLike(node.parent)) return false;
  const hasPrivateModifier = (ts.getModifiers?.(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword,
  );
  return hasPrivateModifier || (node.name !== undefined && ts.isPrivateIdentifier(node.name));
}

function isDocumentableHost(node, exported) {
  if (exported.has(node)) return true;
  if (!MEMBER_KINDS.has(node.kind) || isPrivateClassMember(node)) return false;
  const statement = topLevelStatementOf(node);
  return statement !== undefined && exported.has(statement);
}

function allowedJsDocStarts(sourceFile, exported) {
  const starts = new Set();
  const visit = (node) => {
    if (isDocumentableHost(node, exported)) for (const doc of jsDocsOf(node)) starts.add(doc.pos);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return starts;
}

function isOverloadContinuation(statement, previous) {
  return (
    previous !== undefined &&
    ts.isFunctionDeclaration(statement) &&
    ts.isFunctionDeclaration(previous) &&
    statement.name?.text === previous.name?.text
  );
}

function exampleCount(docs) {
  return docs.flatMap((doc) => doc.tags ?? []).filter((tag) => tag.tagName.text === 'example').length;
}

function undocumentedPublicMembers(statement) {
  if (!ts.isClassDeclaration(statement)) return [];
  return statement.members.filter(
    (member) =>
      !ts.isConstructorDeclaration(member) &&
      !ts.isClassStaticBlockDeclaration(member) &&
      !isPrivateClassMember(member) &&
      jsDocsOf(member).length === 0,
  );
}

function docProblems(statement, name) {
  const docs = jsDocsOf(statement);
  if (docs.length === 0) return [`exported \`${name}\` has no JSDoc`];
  const examples = exampleCount(docs);
  const problems = [];
  if (examples === 0) problems.push(`JSDoc of exported \`${name}\` has no @example`);
  if (examples > 1) {
    problems.push(`JSDoc of exported \`${name}\` has ${examples} @example tags; keep exactly one`);
  }
  return problems;
}

function missingDocs(sourceFile, exported) {
  const problems = [];
  let previous;
  for (const statement of sourceFile.statements) {
    if (exported.has(statement) && !isOverloadContinuation(statement, previous)) {
      const name = declaredNames(statement)[0] ?? 'default export';
      for (const message of docProblems(statement, name)) problems.push({ node: statement, message });
      for (const member of undocumentedPublicMembers(statement)) {
        problems.push({
          node: member,
          message: `public member \`${member.name?.getText()}\` of \`${name}\` has no JSDoc`,
        });
      }
    }
    previous = statement;
  }
  return problems;
}

function overlongJsDocLines(sourceFile, range) {
  const { line: first } = sourceFile.getLineAndCharacterOfPosition(range.pos);
  const { line: last } = sourceFile.getLineAndCharacterOfPosition(range.end);
  const lineStarts = sourceFile.getLineStarts();
  const problems = [];
  for (let line = first; line <= last; line++) {
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] : sourceFile.text.length;
    const length = sourceFile.text.slice(lineStarts[line], end).replace(/\r?\n$/, '').length;
    if (length > MAX_JSDOC_LINE_LENGTH) {
      problems.push({
        line: line + 1,
        message: `JSDoc line is ${length} columns; wrap it at ${MAX_JSDOC_LINE_LENGTH}`,
      });
    }
  }
  return problems;
}

function eslintDisableProblem(comment) {
  const directive = /^\/[/*]\s*eslint-disable(?:-next-line|-line)?\b([\s\S]*?)(?:\*\/)?$/.exec(comment);
  if (!directive) return undefined;
  const [rules, ...reason] = directive[1].split(' -- ');
  if (rules.trim() === '') return 'eslint-disable must name the rules it disables';
  if (reason.join(' -- ').trim() === '') return 'eslint-disable needs a `-- reason`';
  return undefined;
}

/**
 * Comment-policy violations in one file: comments other than machine directives and JSDoc on exported
 * declarations (and their non-private members), JSDoc lines over 110 columns, `eslint-disable` without rule
 * names or a `-- reason`, plus, when `requireDocs` is set, exported declarations without JSDoc and exactly
 * one `@example`, and undocumented public members of exported classes.
 *
 * @example
 * checkSource('src/a.ts', 'const a = 1; // why', true);
 * // [{ line: 1, message: 'comment not allowed: // why' }]
 */
export function checkSource(file, text, requireDocs) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const exported = new Set(exportedDeclarations(sourceFile));
  const allowedDocs = allowedJsDocStarts(sourceFile, exported);
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const problems = [];
  for (const range of allCommentRanges(sourceFile)) {
    const comment = text.slice(range.pos, range.end);
    const directiveProblem = eslintDisableProblem(comment);
    if (directiveProblem) problems.push({ line: lineOf(range.pos), message: directiveProblem });
    if (MACHINE_DIRECTIVE.test(comment)) continue;
    const isJsDoc = comment.startsWith('/**') && comment !== '/**/';
    if (isJsDoc) problems.push(...overlongJsDocLines(sourceFile, range));
    if (isJsDoc && allowedDocs.has(range.pos)) continue;
    problems.push({
      line: lineOf(range.pos),
      message: `comment not allowed: ${comment.split('\n')[0].slice(0, 80)}`,
    });
  }
  if (requireDocs) {
    for (const { node, message } of missingDocs(sourceFile, exported)) {
      problems.push({ line: lineOf(node.getStart(sourceFile)), message });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

const API_CALL = /\b((?:create|use)[A-Z]\w*)\s*[(<]/g;
const DEFINITION = /\b(?:function|const|let|class)\s+(\w+)/g;

function exampleTexts(sourceFile) {
  const texts = [];
  const visit = (node) => {
    for (const doc of jsDocsOf(node)) {
      for (const tag of doc.tags ?? []) {
        if (tag.tagName.text !== 'example') continue;
        texts.push({ pos: tag.pos, text: ts.getTextOfJSDocComment(tag.comment) ?? '' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return texts;
}

/**
 * `create…` and `use…` calls in the file's `@example` code that are neither in `knownNames` (what the package
 * sources and their runtime dependencies export) nor defined in the example itself, so an example cannot
 * teach an API that does not exist.
 *
 * @example
 * unknownNamesInExamples('src/a.ts', text, new Set(['httpAdapter']));
 * // [{ line: 3, message: '@example calls `createHttpAdapter`, which no package source exports' }]
 */
export function unknownNamesInExamples(file, text, knownNames) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const problems = [];
  for (const example of exampleTexts(sourceFile)) {
    const defined = new Set([...example.text.matchAll(DEFINITION)].map((match) => match[1]));
    const called = new Set([...example.text.matchAll(API_CALL)].map((match) => match[1]));
    for (const name of called) {
      if (knownNames.has(name) || defined.has(name)) continue;
      problems.push({
        line: sourceFile.getLineAndCharacterOfPosition(example.pos).line + 1,
        message: `@example calls \`${name}\`, which no package source exports`,
      });
    }
  }
  return problems;
}

const RUNTIME_DEPENDENCIES_USED_IN_EXAMPLES = ['react', 'react-dom/client', '@tanstack/react-virtual'];

async function exportedNamesOfTheRepo(root, sourceFiles) {
  const names = new Set();
  for (const file of sourceFiles) {
    const sourceFile = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of exportedDeclarations(sourceFile)) {
      for (const name of declaredNames(statement)) names.add(name);
    }
  }
  const requireFromReact = createRequire(path.join(root, 'packages', 'react', 'package.json'));
  for (const dependency of RUNTIME_DEPENDENCIES_USED_IN_EXAMPLES) {
    for (const name of Object.keys(requireFromReact(dependency))) names.add(name);
  }
  return names;
}

async function checkRepo(root) {
  const isSource = (name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts');
  const isScript = (name) => /\.m?js$/.test(name) && !/\.test\.m?js$/.test(name);
  const targets = [];
  for (const pkg of await readdir(path.join(root, 'packages'))) {
    const src = path.join(root, 'packages', pkg, 'src');
    for await (const file of filesUnder(src, isSource)) targets.push({ file, requireDocs: true });
    const bench = path.join(root, 'packages', pkg, 'bench');
    if (existsSync(bench)) {
      for await (const file of filesUnder(bench, (name) => isSource(name) || isScript(name))) {
        targets.push({ file, requireDocs: false });
      }
    }
  }
  for await (const file of filesUnder(path.join(root, 'scripts'), isScript)) {
    targets.push({ file, requireDocs: false });
  }
  const packageSources = targets.filter((target) => target.requireDocs).map((target) => target.file);
  const knownNames = await exportedNamesOfTheRepo(root, packageSources);
  const failures = [];
  for (const { file, requireDocs } of targets) {
    const text = await readFile(file, 'utf8');
    const problems = [
      ...checkSource(file, text, requireDocs),
      ...(requireDocs ? unknownNamesInExamples(file, text, knownNames) : []),
    ];
    for (const problem of problems) {
      failures.push(`${path.relative(root, file)}:${problem.line} ${problem.message}`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const failures = await checkRepo(root);
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) {
    console.error(
      `check-comments: ${failures.length} problem(s). Move explanations into names or extracted functions; ` +
        'document exported declarations with JSDoc and an @example.',
    );
    process.exit(1);
  }
}
