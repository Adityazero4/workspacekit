# @scope/pdf

A PDF renderer for the file workspace, drawn by pdf.js one page at a time, with selectable text, links, zoom and a password prompt.

It opens .pdf up to 200 MiB. pdf.js loads the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @scope/pdf @scope/react react react-dom
```

`@scope/react` and `react` are peer dependencies. If you want every renderer at once, install `@scope/workspace` instead.

## Entry

`pdfRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@scope/core/http';
import { lightRenderers, Workspace } from '@scope/react';
import { pdfRenderer } from '@scope/pdf';
import '@scope/react/styles.css';
import '@scope/pdf/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [pdfRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`PdfViewer` shows one file without a tree or a provider.

```tsx
import { PdfViewer } from '@scope/pdf';
import '@scope/react/styles.css';
import '@scope/pdf/styles.css';

export function Preview(): React.JSX.Element {
  return <PdfViewer src="/files/report.pdf" fileName="report.pdf" />;
}
```

`src` is a URL, a `Blob`, an `ArrayBuffer` or a `Uint8Array`.

## CSS

Import `@scope/react/styles.css` and `@scope/pdf/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@scope/workspace`, its single `@scope/workspace/styles.css` covers every package.

## Options

- `workerSrc`: the URL of the pdf.js worker. You do not need it with Vite or Next.js: the default is resolved by your bundler from `new URL(..., import.meta.url)`.
- `assets`: `{ wasmUrl, cMapUrl, standardFontDataUrl }`, directory URLs for pdf.js data files. Only needed for the extras: without them, JPX and JBIG2 images are missing and PDFs that do not embed their CJK or standard fonts use fallback glyphs.
- `workerSrc` on another origin, and any worker in a browser without `Promise.withResolvers` (before Chrome 119 or Safari 17.4, where it starts from a `blob:` wrapper), need `worker-src blob:` in your Content-Security-Policy.
- `maxCanvasPixels`: the cap on each page canvas (default 16 megapixels).
- `classNames`: classes for this package's `pdf-*` parts.

Pass them to the factory, as in `pdfRenderer({ assets: { cMapUrl: '/pdfjs/cmaps/', standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' } })`. `PdfViewer` takes the same options as props.

## Vite

A production build needs no configuration. In the dev server, Vite pre-bundles dependencies, which breaks the `new URL(..., import.meta.url)` worker reference in this package. Exclude it from pre-bundling:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@scope/pdf'],
  },
});
```

The data files in `assets` are not bundled. Serve pdf.js's `cmaps/`, `standard_fonts/` and `wasm/` directories (from `pdfjs-dist` 6.4.299) from your own origin, for instance from Vite's `public/pdfjs/`.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/pdf).
