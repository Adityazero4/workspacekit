const peersAndEnginesMeasuredElsewhere = ['react', '@workspacekit/react'];

export default [
  {
    name: '@workspacekit/template: entry without lazy chunks (renderer entry and TemplateViewer)',
    path: 'dist/index.js',
    limit: '2 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
