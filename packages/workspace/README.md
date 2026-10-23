# @scope/workspace

The one-install preset: `Workspace` with every renderer, plus the whole `@scope/react` API.

## Install

```sh
npm install @scope/workspace @scope/core react react-dom
```

`@scope/workspace/styles.css` is a list of bare `@import`s (one per package), so it needs a bundler that resolves them, such as Vite or Next.js. Install `@scope/core` yourself because your code imports `@scope/core/http`: a package manager with strict resolution, such as pnpm, only lets an app import what is in its own `package.json`.

## Entry

```tsx
// page.tsx
'use client';
import { Workspace } from '@scope/workspace';
import { httpAdapter } from '@scope/core/http';
import '@scope/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
```

Pair it with `createFileHandler` from `@scope/server` on the server. `Workspace` fills its parent, so give the parent a height.

## Standalone use

To show one file without the tree, put `FileViewer` inside a `FileSystemProvider` and give it `allRenderers()`. Both come from this package, which re-exports `@scope/react`.

```tsx
import { allRenderers, FileSystemProvider, FileViewer } from '@scope/workspace';
import { httpAdapter } from '@scope/core/http';
import '@scope/workspace/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = allRenderers();

export function Preview({ path }: { path: string }): React.JSX.Element {
  return (
    <FileSystemProvider adapter={adapter}>
      <FileViewer path={path} renderers={renderers} />
    </FileSystemProvider>
  );
}
```

## CSS

Import `@scope/workspace/styles.css` once. It pulls in the stylesheet of every package, in layer order, so you never import the per-package ones. Everything is in `@layer fs`, so your own CSS wins.

## Why `@scope/react` is a dependency

`@scope/react` is a dependency here, not a peer. The preset re-exports it and owns its version, so the renderer packages it installs always match it.

## Renderer options

`Workspace` uses `allRenderers()`. To configure a renderer package, pass its options to `allRenderers` and give the result to `Workspace`; the precedence order stays the same:

```tsx
import { httpAdapter } from '@scope/core/http';
import { allRenderers, Workspace } from '@scope/workspace';

const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? undefined;

const renderers = allRenderers({
  pdf: { workerSrc: '/pdfjs/pdf.worker.min.mjs' },
  code: { nonce },
});

export function Files(): React.JSX.Element {
  return <Workspace adapter={httpAdapter('/api/files')} renderers={renderers} />;
}
```

With a strict Content-Security-Policy, the PDF worker needs `worker-src blob:` when it is served from another origin or the browser lacks `Promise.withResolvers` (before Chrome 119 or Safari 17.4).

To open `.xls`, `.xlsb` and `.ods` files, install SheetJS and add `spreadsheet: { engines: { xlsx: () => import('xlsx') } }`. Without it those files show how to add it.

## Vite

Vite 7 and 8 are supported. Set `worker: { format: 'es' }`: the spreadsheet reader's worker is code-split, which Vite's default `iife` worker format rejects, so `vite build` fails without it. With that, pdf.js's worker and the spreadsheet reader's worker are emitted from the `new URL(…, import.meta.url)` references in the packages' `dist`.

The dev server pre-bundles dependencies into `node_modules/.vite/deps`, where those references point nowhere. Exclude the two packages that hold them from pre-bundling, and pre-bundle the CommonJS modules the spreadsheet worker imports instead (Vite's `>` names a dependency of a dependency):

```ts
// not-compiled: needs @vitejs/plugin-react, which comes with the Vite React template and is not installed here
// vite.config.ts
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
```

If you install `@scope/spreadsheet` directly rather than through this package, drop the `@scope/workspace > ` prefix.

## pdf.js data files

Without them, JPX and JBIG2 images are missing and PDFs that do not embed their CJK or standard fonts draw with fallback glyphs. Serve pdf.js's `cmaps/`, `standard_fonts/` and `wasm/` directories (from `pdfjs-dist` 6.4.299, the version `@scope/pdf` pins) from your origin, for instance by copying them into Vite's `public/pdfjs/`, and pass their URLs:

```ts
import { allRenderers } from '@scope/workspace';

export const renderers = allRenderers({
  pdf: {
    assets: {
      cMapUrl: '/pdfjs/cmaps/',
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    },
  },
});
```

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/workspace).
