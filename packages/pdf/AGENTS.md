# @workspacekit/pdf: notes for coding agents

The pdfRenderer() entry for PDF files. It needs `@workspacekit/react` and `react` installed. To get every renderer with one import, use `@workspacekit/workspace` instead.

- Import only from `@workspacekit/pdf` and `@workspacekit/pdf/styles.css`.
- Call `pdfRenderer()` once, at module level, and put the result before `lightRenderers` in the `renderers` array. A new renderer object on every render makes the viewer reload.
- Import `@workspacekit/react/styles.css` and `@workspacekit/pdf/styles.css` once.
- `classNames` on this package's factory take this package's parts only; the viewer's own `classNames` know the `@workspacekit/react` parts.
- Do not import the engine (pdf.js) yourself. It loads on demand.
- With a strict Content-Security-Policy, allow `worker-src blob:` (see the README Options).
- In Vite's dev server, exclude `@workspacekit/pdf` from `optimizeDeps`. See the README.

```tsx
import { lightRenderers } from '@workspacekit/react';
import { pdfRenderer } from '@workspacekit/pdf';

export const renderers = [pdfRenderer(), ...lightRenderers];
```

Machine-readable index: `llms.txt` in this package.

<!-- common-mistakes:start -->

## Common mistakes

1. **No `authorize`.** `createFileHandler` has no default-open mode: `authorize(req, op, path)` is required and must return `true` for each request you allow. Check the signed-in user there, and deny `'list'`, `'search'` and `'watch'` to anyone who must not see the whole tree. A denied `'watch'` makes the client poll `list`, so deny `'list'` too.
2. **No stylesheet.** Import `@workspacekit/workspace/styles.css` once (or `@workspacekit/react/styles.css` when you use `@workspacekit/react` alone). Without it the components render unstyled. It needs a bundler that resolves CSS imports, such as Vite or Next.js.
3. **A non-public import.** Import only from the paths in each package's `exports` map: `@workspacekit/core`, `@workspacekit/core/http`, `@workspacekit/core/memory`, `@workspacekit/core/docs`, `@workspacekit/react`, `@workspacekit/react/renderers`, `@workspacekit/react/renderer-kit`, the `.` entry of every other package, and the `styles.css` files. Never import from `dist/` or `src/`.
4. **No `'use client'` in Next.js.** The components use state and effects. Put `'use client'` at the top of the file that renders `Workspace`, or import it from a client component.
5. **A Vite config without the worker settings.** When `@workspacekit/spreadsheet` is in the build (it is in the `@workspacekit/workspace` preset; `@workspacekit/pdf` alone does not need it), set `worker: { format: 'es' }`, because the code-split spreadsheet worker makes `vite build` fail without it. In Vite's dev server, also exclude `@workspacekit/pdf` and `@workspacekit/spreadsheet` from `optimizeDeps` so their workers resolve, and add the nested `include` entries for the CommonJS modules the spreadsheet worker imports. The exact lines are in the `@workspacekit/workspace` README.

<!-- common-mistakes:end -->
