# @scope/spreadsheet

A spreadsheet renderer for the file workspace: .xlsx, .csv and .tsv in a virtualized grid with sheet tabs, search, frozen panes and merged cells.

It opens .xlsx, .xlsm, .csv and .tsv up to 50 MiB. The grid and the reader worker load the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @scope/spreadsheet @scope/react react react-dom
```

`@scope/react` and `react` are peer dependencies. If you want every renderer at once, install `@scope/workspace` instead.

## Entry

`spreadsheetRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@scope/core/http';
import { lightRenderers, Workspace } from '@scope/react';
import { spreadsheetRenderer } from '@scope/spreadsheet';
import '@scope/react/styles.css';
import '@scope/spreadsheet/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [spreadsheetRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`SpreadsheetViewer` shows one file without a tree or a provider.

```tsx
import { SpreadsheetViewer } from '@scope/spreadsheet';
import '@scope/react/styles.css';
import '@scope/spreadsheet/styles.css';

export function Preview(): React.JSX.Element {
  return <SpreadsheetViewer src="/files/budget.xlsx" fileName="budget.xlsx" />;
}
```

`src` is a URL, a `Blob`, an `ArrayBuffer` or a `Uint8Array`.

## CSS

Import `@scope/react/styles.css` and `@scope/spreadsheet/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@scope/workspace`, its single `@scope/workspace/styles.css` covers every package.

## Options

- `engines.xlsx`: loads SheetJS so `.xls`, `.xlsb` and `.ods` open too, as in `{ xlsx: () => import('xlsx') }`. Without it those files show how to add it.
- `workerFactory`: replaces the default reader worker.
- `classNames`: classes for this package's `sheet-*` parts.

Pass them to the factory, as in `spreadsheetRenderer({ classNames: { 'sheet-grid': 'grid' } })`. `SpreadsheetViewer` takes the same options as props.

## Vite

Set `worker: { format: 'es' }` (Vite 7 and 8): the reader worker is code-split, which Vite's default `iife` worker format rejects. In the dev server, Vite pre-bundles dependencies, which breaks the `new URL(..., import.meta.url)` worker reference in this package. Exclude it from pre-bundling, and pre-bundle the CommonJS modules its worker imports (Vite's `>` names a dependency of a dependency):

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@scope/spreadsheet'],
    include: [
      '@scope/spreadsheet > papaparse',
      '@scope/spreadsheet > saxes',
      '@scope/spreadsheet > numfmt',
      '@scope/spreadsheet > fast-formula-parser',
    ],
  },
});
```

The `include` entries are required whenever you exclude the package.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/spreadsheet).
