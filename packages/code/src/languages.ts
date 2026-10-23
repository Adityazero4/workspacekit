import type { LanguageDescription } from '@codemirror/language';

const SHELL = 'Shell';
const JSON_LANGUAGE = 'JSON';
const PROPERTIES = 'Properties files';
const RUBY = 'Ruby';

const LANGUAGE_BY_BASENAME: ReadonlyMap<string, string> = new Map([
  ['makefile', SHELL],
  ['gnumakefile', SHELL],
  ['pkgbuild', SHELL],
  ['.env', SHELL],
  ['.gitignore', SHELL],
  ['.dockerignore', SHELL],
  ['.npmignore', SHELL],
  ['.prettierignore', SHELL],
  ['.eslintignore', SHELL],
  ['.bashrc', SHELL],
  ['.bash_profile', SHELL],
  ['.zshrc', SHELL],
  ['.profile', SHELL],
  ['.editorconfig', PROPERTIES],
  ['.npmrc', PROPERTIES],
  ['.prettierrc', JSON_LANGUAGE],
  ['.eslintrc', JSON_LANGUAGE],
  ['.babelrc', JSON_LANGUAGE],
  ['dockerfile', 'Dockerfile'],
  ['containerfile', 'Dockerfile'],
  ['gemfile', RUBY],
  ['rakefile', RUBY],
  ['vagrantfile', RUBY],
  ['podfile', RUBY],
  ['jenkinsfile', 'Groovy'],
  ['cmakelists.txt', 'CMake'],
]);

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['jsonc', JSON_LANGUAGE],
  ['json5', JSON_LANGUAGE],
  ['svelte', 'HTML'],
  ['astro', 'HTML'],
  ['mdx', 'Markdown'],
  ['mk', SHELL],
  ['zsh', SHELL],
  ['env', SHELL],
  ['cfg', PROPERTIES],
  ['conf', PROPERTIES],
  ['pyi', 'Python'],
]);

const HIGHLIGHTED_EXTENSIONS = [
  ...['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'css', 'scss', 'sass', 'less', 'styl'],
  ...['json', 'yaml', 'yml', 'toml', 'xml', 'xsl', 'xsd', 'ini', 'properties', 'proto', 'sql'],
  ...['sh', 'bash', 'ksh', 'ps1', 'psm1', 'psd1', 'py', 'pyw', 'rb', 'pl', 'pm', 'php', 'lua', 'r', 'tcl'],
  ...['go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'swift', 'dart', 'cs', 'fs', 'vb'],
  ...['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'd', 'pas', 'f90', 'wat', 'cmake'],
  ...['hs', 'elm', 'erl', 'clj', 'cljs', 'cljc', 'edn', 'coffee', 'lisp', 'el', 'jl', 'tex'],
  ...['jinja', 'j2', 'liquid', 'hbs', 'pug', 'diff', 'patch'],
];

const CODE_WITHOUT_A_CODEMIRROR_LANGUAGE = ['zig', 'tf', 'tfvars', 'hcl', 'graphql', 'gql', 'ex', 'exs'];

/**
 * Lower-cased extensions of code, configuration and data files the code renderer claims: those CodeMirror
 * highlights, those the alias table maps to a language, and a few code formats it shows without highlighting
 * because CodeMirror has no language for them (`.zig`, `.tf`, `.tfvars`, `.hcl`, `.graphql`, `.gql`, `.ex`,
 * `.exs`). Plain text (`.txt`), HTML, SVG, CSV and Markdown are left to their own renderers.
 *
 * @example
 * ```ts
 * CODE_EXTENSIONS.has('jsonc'); // true
 * ```
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...HIGHLIGHTED_EXTENSIONS,
  ...LANGUAGE_BY_EXTENSION.keys(),
  ...CODE_WITHOUT_A_CODEMIRROR_LANGUAGE,
]);

/**
 * Lower-cased Markdown extensions, which the code renderer takes only when no Markdown renderer does.
 *
 * @example
 * ```ts
 * MARKDOWN_EXTENSIONS.has('md'); // true
 * ```
 */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mkd']);

const isEnvFile = (basename: string): boolean => basename === '.env' || basename.startsWith('.env.');

const languageNameOfBasename = (basename: string): string | undefined =>
  isEnvFile(basename) ? SHELL : LANGUAGE_BY_BASENAME.get(basename);

/**
 * Whether the alias table names a language for this lower-cased file name, such as `makefile` or
 * `.env.local`; the code renderer claims those files.
 *
 * @example
 * ```ts
 * hasAliasedBasename('.gitignore'); // true
 * ```
 */
export function hasAliasedBasename(basename: string): boolean {
  return languageNameOfBasename(basename) !== undefined;
}

function extensionOf(lowerCasedName: string): string {
  const lastDot = lowerCasedName.lastIndexOf('.');
  return lastDot <= 0 ? '' : lowerCasedName.slice(lastDot + 1);
}

/**
 * The language for a file name (a bare name or a path), from `languages` (CodeMirror's
 * `@codemirror/language-data` list): the alias table's whole names first, then CodeMirror's own file-name
 * patterns, then the alias table's extensions, then CodeMirror's extensions, ignoring case. `null` when
 * none fits. The alias table covers names CodeMirror misses, such as `Makefile`, `.env`, `.gitignore` and
 * `.jsonc`. Some aliases approximate: Makefiles, `.env` files and ignore files are highlighted as Shell
 * (comments, strings and variables read right; Make-specific syntax is not recognised). `.zig`, `.tf`,
 * `.graphql` and `.ex` get no language, so they show as plain text in the code editor.
 *
 * @example
 * ```ts
 * const { languages } = await import('@codemirror/language-data');
 * matchFilename(languages, 'settings.jsonc')?.name; // 'JSON'
 * ```
 */
export function matchFilename(
  languages: readonly LanguageDescription[],
  fileName: string,
): LanguageDescription | null {
  const name = fileName.slice(fileName.lastIndexOf('/') + 1);
  const lowerCasedName = name.toLowerCase();
  const extension = extensionOf(lowerCasedName);
  const named = (languageName: string | undefined): LanguageDescription | undefined =>
    languageName === undefined ? undefined : languages.find((language) => language.name === languageName);
  return (
    named(languageNameOfBasename(lowerCasedName)) ??
    languages.find((language) => language.filename?.test(name)) ??
    named(LANGUAGE_BY_EXTENSION.get(extension)) ??
    languages.find((language) => extension !== '' && language.extensions.includes(extension)) ??
    null
  );
}

/**
 * The language whose name or alias is `name`, ignoring case, such as `python`, `TS` or `C++`; `null` when
 * none is.
 *
 * @example
 * ```ts
 * const { languages } = await import('@codemirror/language-data');
 * matchLanguageName(languages, 'ts')?.name; // 'TypeScript'
 * ```
 */
export function matchLanguageName(
  languages: readonly LanguageDescription[],
  name: string,
): LanguageDescription | null {
  const wanted = name.toLowerCase();
  return (
    languages.find((language) => language.name.toLowerCase() === wanted || language.alias.includes(wanted)) ??
    null
  );
}
