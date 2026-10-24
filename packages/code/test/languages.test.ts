import { languages } from '@codemirror/language-data';
import { fileInfo, lightRenderers, resolveRenderer, type FileInfo } from '@workspacekit/react';
import { expect, test } from 'vitest';
import { codeRenderer } from '../src';
import { matchFilename, matchLanguageName } from '../src/languages';

const renderers = [codeRenderer(), ...lightRenderers];
const languageOf = (fileName: string): string | undefined => matchFilename(languages, fileName)?.name;
const file = (name: string, size?: number): FileInfo =>
  fileInfo({ path: `src/${name}`, name, kind: 'file', size });

test('Makefile, .env, .gitignore and .jsonc get a language', () => {
  expect(languageOf('Makefile')).toBe('Shell');
  expect(languageOf('GNUmakefile')).toBe('Shell');
  expect(languageOf('.env')).toBe('Shell');
  expect(languageOf('.env.local')).toBe('Shell');
  expect(languageOf('.gitignore')).toBe('Shell');
  expect(languageOf('settings.jsonc')).toBe('JSON');
  expect(languageOf('Component.svelte')).toBe('HTML');
  expect(languageOf('page.mdx')).toBe('Markdown');
  expect(languageOf('setup.cfg')).toBe('Properties files');
  expect(languageOf('Containerfile')).toBe('Dockerfile');
});

test('names the alias table leaves alone keep CodeMirror matching, case-insensitively by extension', () => {
  expect(languageOf('Dockerfile')).toBe('Dockerfile');
  expect(languageOf('CMakeLists.txt')).toBe('CMake');
  expect(languageOf('nginx.conf')).toBe('Nginx');
  expect(languageOf('main.ts')).toBe('TypeScript');
  expect(languageOf('MAIN.PY')).toBe('Python');
  expect(languageOf('notes.txt')).toBeUndefined();
  expect(languageOf('LICENSE')).toBeUndefined();
});

test('a language prop matches a language name or alias', () => {
  expect(matchLanguageName(languages, 'python')?.name).toBe('Python');
  expect(matchLanguageName(languages, 'TS')?.name).toBe('TypeScript');
  expect(matchLanguageName(languages, 'no-such-language')).toBeNull();
});

test('code, config and data files go to the code renderer; plain text, HTML and images do not', () => {
  const winner = (name: string, size?: number): string | undefined =>
    resolveRenderer(file(name, size), renderers)?.id;
  for (const name of [
    'a.ts',
    'a.json',
    'a.yaml',
    'a.toml',
    'Makefile',
    '.env.production',
    'a.jsonc',
    'a.zig',
  ]) {
    expect(winner(name), name).toBe('code');
  }
  expect(winner('notes.txt')).toBe('text');
  expect(winner('index.html')).toBe('html');
  expect(winner('logo.svg')).toBe('image');
  expect(winner('README.md')).toBe('code');
});

test('Markdown scores generic, so a markdown renderer that scores specific keeps .md', () => {
  const renderer = codeRenderer();
  expect(renderer.match(file('README.md'))).toBe(10);
  expect(renderer.match(file('a.ts'))).toBe(20);
  expect(renderer.match(file('notes.txt'))).toBe(false);
  expect(renderer.match(fileInfo({ path: 'src', name: 'src', kind: 'directory' }))).toBe(false);
});

test('the registry entry is editable text up to 10 MiB', () => {
  const { input, editable, maxBytes } = codeRenderer();
  expect({ input, editable, maxBytes }).toEqual({
    input: 'text',
    editable: true,
    maxBytes: 10 * 1024 * 1024,
  });
});
