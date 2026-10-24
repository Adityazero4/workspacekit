const peersAndEnginesMeasuredElsewhere = [
  'react',
  '@workspacekit/react',
  'docx-preview',
  'dompurify',
  'fflate',
];

export default [
  {
    name: '@workspacekit/docx: all of our own code, entry and lazy chunk, docx-preview, DOMPurify and fflate external',
    path: 'dist/*.js',
    limit: '7.5 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
