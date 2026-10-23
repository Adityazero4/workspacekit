const peersMeasuredElsewhere = ['react', '@scope/react', '@tanstack/react-virtual'];
const readerEnginesMeasuredElsewhere = ['fflate', 'saxes', 'papaparse', 'numfmt', 'fast-formula-parser'];

export default [
  {
    name: '@scope/spreadsheet grid: our own main-thread code, TanStack Virtual external',
    path: ['dist/*.js', '!dist/worker.js'],
    limit: '15 KB',
    gzip: true,
    ignore: [...peersMeasuredElsewhere, ...readerEnginesMeasuredElsewhere],
  },
  {
    name: '@scope/spreadsheet reader: our own worker code, fflate, saxes, papaparse, numfmt and the formula engine external',
    path: 'dist/worker.js',
    limit: '40 KB',
    gzip: true,
    ignore: readerEnginesMeasuredElsewhere,
  },
];
