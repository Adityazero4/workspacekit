const peersAndEnginesMeasuredElsewhere = ['react', '@scope/react', '@aiden0z/pptx-renderer', 'jszip'];

export default [
  {
    name: '@scope/pptx: all of our own code, entry and lazy chunk, @aiden0z/pptx-renderer and JSZip external',
    path: 'dist/*.js',
    limit: '8.5 KB',
    gzip: true,
    ignore: peersAndEnginesMeasuredElsewhere,
  },
];
