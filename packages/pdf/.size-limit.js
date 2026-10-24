const peersAndEnginesMeasuredElsewhere = ['react', '@workspacekit/react', 'pdfjs-dist'];

export default [
  {
    name: '@workspacekit/pdf: all of our own code, entry and lazy chunk, pdf.js external',
    path: 'dist/*.js',
    limit: '8 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
