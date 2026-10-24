import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@workspacekit/pdf', '@workspacekit/spreadsheet'],
    include: [
      '@workspacekit/workspace > @workspacekit/spreadsheet > papaparse',
      '@workspacekit/workspace > @workspacekit/spreadsheet > saxes',
      '@workspacekit/workspace > @workspacekit/spreadsheet > numfmt',
      '@workspacekit/workspace > @workspacekit/spreadsheet > fast-formula-parser',
    ],
  },
});
