/**
 * Lower-cased extensions of raster and vector images a browser can draw in an `<img>`.
 *
 * @example
 * ```ts
 * IMAGE_EXTENSIONS.has('png'); // true
 * ```
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
]);

/**
 * Lower-cased TIFF extensions. Browsers cannot draw TIFF, so these need a decoder.
 *
 * @example
 * ```ts
 * TIFF_EXTENSIONS.has('tif'); // true
 * ```
 */
export const TIFF_EXTENSIONS: ReadonlySet<string> = new Set(['tif', 'tiff']);

/**
 * Lower-cased extensions of audio formats played with an `<audio>` element.
 *
 * @example
 * ```ts
 * AUDIO_EXTENSIONS.has('mp3'); // true
 * ```
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aac',
  'm4a',
  'weba',
]);

/**
 * Lower-cased extensions of video formats played with a `<video>` element.
 *
 * @example
 * ```ts
 * VIDEO_EXTENSIONS.has('mp4'); // true
 * ```
 */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

/**
 * Lower-cased extensions of HTML documents.
 *
 * @example
 * ```ts
 * HTML_EXTENSIONS.has('htm'); // true
 * ```
 */
export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);

/**
 * Lower-cased extensions of plain-text, configuration and source-code files.
 *
 * @example
 * ```ts
 * TEXT_EXTENSIONS.has('ts'); // true
 * ```
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'log',
  'md',
  'json',
  'yaml',
  'yml',
  'toml',
  'csv',
  'tsv',
  'xml',
  'ini',
  'cfg',
  'conf',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'sql',
  'r',
  'lua',
  'pl',
  'scala',
  'dart',
  'vue',
  'svelte',
  'css',
  'scss',
  'sass',
  'less',
  'graphql',
  'gql',
  'proto',
  'diff',
  'patch',
  'env',
  'gitignore',
  'dockerignore',
  'editorconfig',
  'lock',
  'properties',
]);

/**
 * Lower-cased whole file names that are text although they have no useful extension.
 *
 * @example
 * ```ts
 * TEXT_BASENAMES.has('makefile'); // true
 * ```
 */
export const TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'procfile',
  'gemfile',
  'rakefile',
  'vagrantfile',
  'jenkinsfile',
  'license',
  'licence',
  'readme',
  'changelog',
  'authors',
  'contributing',
  'codeowners',
  '.env',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
]);
