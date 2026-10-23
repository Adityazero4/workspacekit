import {
  defineRenderer,
  MATCH_SCORE,
  type FileInfo,
  type Renderer,
  type RendererProps,
} from '@scope/react/renderer-kit';
import { createElement } from 'react';
import type { SheetClassNames } from './parts';

/**
 * The largest spreadsheet the renderer and the standalone `SpreadsheetViewer` open: 50 MiB. A larger file
 * is `too_large` and is never read.
 *
 * @example
 * ```ts
 * useStandaloneBytes(src, onError, { maxBytes: SPREADSHEET_MAX_BYTES });
 * ```
 */
export const SPREADSHEET_MAX_BYTES: number = 50 * 1024 * 1024;

/**
 * Options of `spreadsheetRenderer` and `SpreadsheetViewer`.
 * - `engines.xlsx` loads SheetJS for `.xls`, `.xlsb` and `.ods`, which our own reader does not open, as in
 *   `{ xlsx: () => import('xlsx') }`. Without it those files show how to add it. SheetJS runs on the main
 *   thread (an injected module cannot cross into the worker), and so does search in those files.
 * - `workerFactory` replaces the default reader worker,
 *   `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.
 * - `classNames` adds classes to this package's parts.
 *
 * @example
 * ```ts
 * const options: SpreadsheetRendererOptions = { engines: { xlsx: () => import('xlsx') } };
 * ```
 */
export interface SpreadsheetRendererOptions {
  engines?: { xlsx?: () => Promise<unknown> };
  workerFactory?: () => Worker;
  classNames?: SheetClassNames;
}

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv']);

const matchScore = (file: FileInfo): number | false =>
  file.kind === 'file' && SPREADSHEET_EXTENSIONS.has(file.extension) && MATCH_SCORE.specific;

/**
 * Creates the registry entry for spreadsheets up to 50 MiB: `.xlsx` and `.xlsm` (read by our own bounded
 * reader in a worker), `.csv` and `.tsv` (papaparse, in the same worker), and `.xls`, `.xlsb` and `.ods`
 * through an injected SheetJS (`engines.xlsx`). Sheets show in a virtualized grid with sheet tabs, search,
 * frozen panes, merged cells and resizable columns; a sheet over 20,000 rows, 500 columns or 200,000 cells
 * shows its first part. The `raw` mode shows CSV and TSV as plain text. The grid and the reader load when the
 * viewer first shows such a file.
 *
 * The reader's worker is found with `new URL('./worker.js', import.meta.url)`. Vite resolves that in a
 * build, but not inside a dependency it pre-bundles in development: exclude this package and pre-bundle the
 * CommonJS modules its worker imports, `optimizeDeps: { exclude: ['@scope/spreadsheet'], include:
 * ['papaparse', 'saxes', 'numfmt', 'fast-formula-parser'].map((name) => `@scope/spreadsheet > ${name}`) }`,
 * or pass `workerFactory`.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [spreadsheetRenderer({ engines: { xlsx: () => import('xlsx') } }), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function spreadsheetRenderer(options: SpreadsheetRendererOptions = {}): Renderer {
  return defineRenderer({
    id: 'spreadsheet',
    match: matchScore,
    load: async () => {
      const { SpreadsheetRenderer } = await import('./SpreadsheetDocument');
      return {
        default: (props: RendererProps) =>
          createElement(SpreadsheetRenderer, { ...props, ...options, classNames: options.classNames }),
      };
    },
    input: 'arrayBuffer',
    maxBytes: SPREADSHEET_MAX_BYTES,
    modes: [
      { value: 'table', label: 'Table' },
      { value: 'raw', label: 'Raw' },
    ],
  });
}
