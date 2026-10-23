const peersAndEnginesMeasuredElsewhere = [
  'react',
  '@scope/react',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/language-data',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
];

export default [
  {
    name: '@scope/code: all of our own code, entry and lazy chunk, CodeMirror external',
    path: 'dist/*.js',
    limit: '5 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
