import { defineConfig } from 'tsdown';

const NODE_SHEBANG = '#!/usr/bin/env node';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  dts: true,
  platform: 'node',
  fixedExtension: false,
  banner: (chunk) => (chunk.fileName === 'cli.js' ? NODE_SHEBANG : ''),
});
