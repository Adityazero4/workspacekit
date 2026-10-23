const peersAndEnginesMeasuredElsewhere = ['react', '@scope/react', 'pdfjs-dist'];

export default [
  {
    name: '@scope/pdf: all of our own code, entry and lazy chunk, pdf.js external',
    path: 'dist/*.js',
    limit: '8 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
