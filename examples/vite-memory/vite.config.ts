import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@scope/pdf', '@scope/spreadsheet'],
    include: [
      '@scope/workspace > @scope/spreadsheet > papaparse',
      '@scope/workspace > @scope/spreadsheet > saxes',
      '@scope/workspace > @scope/spreadsheet > numfmt',
      '@scope/workspace > @scope/spreadsheet > fast-formula-parser',
    ],
  },
});
