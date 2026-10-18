import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = (p: string): string => fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

// Resolve workspace sources directly so tests do not depend on a prior `pnpm build`.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@scope\/core\/(http|memory)$/, replacement: core('$1/index.ts') },
      { find: /^@scope\/core$/, replacement: core('index.ts') },
    ],
  },
});
