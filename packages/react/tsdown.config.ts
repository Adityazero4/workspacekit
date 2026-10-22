import babel from '@rolldown/plugin-babel';
import { defineConfig } from 'tsdown';

const useClientBannerReplacesDroppedModuleDirectives = { js: "'use client';" };

export default defineConfig({
  entry: { index: 'src/index.ts', 'renderers/index': 'src/renderers/index.ts' },
  format: 'esm',
  dts: true,
  platform: 'browser',
  fixedExtension: false,
  banner: useClientBannerReplacesDroppedModuleDirectives,
  inputOptions: { checks: { moduleLevelDirective: false } },
  copy: [{ from: 'src/styles.css', to: 'dist' }],
  plugins: [
    babel({
      plugins: [['babel-plugin-react-compiler', { target: '19' }]],
    }),
  ],
});
