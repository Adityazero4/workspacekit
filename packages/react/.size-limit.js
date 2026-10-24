import { readdirSync } from 'node:fs';

const outsideOurCode = [
  'react',
  'react-dom',
  '@workspacekit/core',
  '@radix-ui/react-dialog',
  '@radix-ui/react-dropdown-menu',
  '@tanstack/react-virtual',
  'utif2',
];
const lightRendererChunks = [
  'TextViewer',
  'HtmlViewer',
  'ImageViewer',
  'TiffViewer',
  'decodeTiff',
  'AudioViewer',
  'VideoViewer',
  'DirectoryViewer',
];
const builtFiles = readdirSync(new URL('dist', import.meta.url));
const builtChunk = (name) => builtFiles.find((file) => file.startsWith(`${name}-`) && file.endsWith('.js'));

export default [
  {
    name: '@workspacekit/react: FileSystemProvider and FileTree',
    path: 'dist/index.js',
    import: '{ FileSystemProvider, FileTree }',
    entry: ['index'],
    limit: '42 KB',
    gzip: true,
    ignore: outsideOurCode,
  },
  {
    name: '@workspacekit/react: Workspace',
    path: 'dist/index.js',
    import: '{ Workspace }',
    entry: ['index'],
    limit: '67 KB',
    gzip: true,
    ignore: outsideOurCode,
  },
  ...lightRendererChunks.map((name) => {
    const file = builtChunk(name);
    return {
      name: `@workspacekit/react ${name} chunk`,
      path: `dist/${file}`,
      entry: [file.replace(/\.js$/, '')],
      limit: '8 KB',
      gzip: true,
      ignore: outsideOurCode,
    };
  }),
];
