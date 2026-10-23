const peersAndEnginesMeasuredElsewhere = ['react', '@scope/react'];

export default [
  {
    name: '@scope/template: entry without lazy chunks (renderer entry and TemplateViewer)',
    path: 'dist/index.js',
    limit: '2 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
