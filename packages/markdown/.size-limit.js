const peersAndEnginesMeasuredElsewhere = [
  'react',
  'react-dom',
  '@workspacekit/react',
  'lexical',
  '@lexical/code-core',
  '@lexical/extension',
  '@lexical/history',
  '@lexical/link',
  '@lexical/list',
  '@lexical/markdown',
  '@lexical/react',
  '@lexical/rich-text',
  '@lexical/selection',
  '@lexical/table',
  '@lexical/utils',
];

export default [
  {
    name: '@workspacekit/markdown: all of our own code, entry and lazy chunk, Lexical external',
    path: 'dist/*.js',
    limit: '30 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
