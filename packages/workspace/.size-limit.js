const peersAndPackagesMeasuredElsewhere = [
  'react',
  'react-dom',
  '@scope/react',
  '@scope/code',
  '@scope/docx',
  '@scope/markdown',
  '@scope/pdf',
  '@scope/pptx',
  '@scope/spreadsheet',
];

export default [
  {
    name: '@scope/workspace: the entry, every renderer package external',
    path: 'dist/index.js',
    limit: '2 KB',
    gzip: true,
    ignore: peersAndPackagesMeasuredElsewhere,
  },
];
