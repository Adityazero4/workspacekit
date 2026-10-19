import { defineConfig } from 'vite';
import {
  compileReactSourcesLikeTheBuild,
  testAgainstWorkspaceSourcesWithoutABuild,
} from '../vitest.shared.ts';

const ONE_PAGE_BUNDLING_REACT_AND_RADIX_KB = 1024;

export default defineConfig({
  root: import.meta.dirname,
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: ONE_PAGE_BUNDLING_REACT_AND_RADIX_KB,
    rolldownOptions: { checks: { moduleLevelDirective: false } },
  },
  logLevel: 'warn',
});
