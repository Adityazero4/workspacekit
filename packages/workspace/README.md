# @scope/workspace

The one-install preset: `Workspace` with every renderer, plus the whole `@scope/react` API.

`@scope/workspace/styles.css` is a list of bare `@import`s (one per package), so it needs a bundler that resolves them, such as Vite or Next.js. `@scope/core` is a dependency, not just a transitive one, so `import { httpAdapter } from '@scope/core/http'` resolves in the app that installs only this package. `@scope/react` is a dependency too, not a peer: the preset re-exports it and owns its version, so the renderer packages it installs always match it.

## Renderer options

`Workspace` uses `allRenderers()`. To configure a renderer package, pass its options to `allRenderers` and give the result to `Workspace`; the precedence order stays the same:

```tsx
import { allRenderers, Workspace } from '@scope/workspace';

const renderers = allRenderers({
  pdf: { workerSrc: '/pdfjs/pdf.worker.min.mjs' },
  spreadsheet: { engines: { xlsx: () => import('xlsx') } },
  code: { nonce },
});

export function Files(): React.JSX.Element {
  return <Workspace adapter={httpAdapter('/api/files')} renderers={renderers} />;
}
```

## Vite

A production build (`vite build`) needs no configuration: pdf.js's worker and the spreadsheet reader's worker are emitted from the `new URL(…, import.meta.url)` references in the packages' `dist`. `pnpm --filter @scope/workspace consumer:dist` checks that on every `pnpm check`.

The dev server pre-bundles dependencies into `node_modules/.vite/deps`, where those references point nowhere. Exclude the two packages that hold them from pre-bundling, and pre-bundle the CommonJS modules the spreadsheet worker imports instead (Vite's `>` names a dependency of a dependency):

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
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
allRenderers({
  pdf: {
    assets: {
      cMapUrl: '/pdfjs/cmaps/',
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    },
  },
});
```
