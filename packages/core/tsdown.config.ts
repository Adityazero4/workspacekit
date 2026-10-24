import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/http/index.ts', 'src/memory/index.ts', 'src/docs/index.ts'],
  format: 'esm',
  dts: true,
  platform: 'neutral',
});
