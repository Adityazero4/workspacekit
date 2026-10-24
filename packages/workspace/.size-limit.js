const peersAndPackagesMeasuredElsewhere = [
  'react',
  'react-dom',
  '@workspacekit/react',
  '@workspacekit/code',
  '@workspacekit/docx',
  '@workspacekit/markdown',
  '@workspacekit/pdf',
  '@workspacekit/pptx',
  '@workspacekit/spreadsheet',
];

export default [
  {
    name: '@workspacekit/workspace: the entry, every renderer package external',
    path: 'dist/index.js',
    limit: '2 KB',
    gzip: true,
    ignore: peersAndPackagesMeasuredElsewhere,
  },
];
