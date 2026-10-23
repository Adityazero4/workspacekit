# @scope/spreadsheet: notes for coding agents

The spreadsheetRenderer() entry for spreadsheets. It needs `@scope/react` and `react` installed. To get every renderer with one import, use `@scope/workspace` instead.

- Import only from `@scope/spreadsheet` and `@scope/spreadsheet/styles.css`.
- Call `spreadsheetRenderer()` once, at module level, and put the result before `lightRenderers` in the `renderers` array. A new renderer object on every render makes the viewer reload.
- Import `@scope/react/styles.css` and `@scope/spreadsheet/styles.css` once.
- `classNames` on this package's factory take this package's parts only; the viewer's own `classNames` know the `@scope/react` parts.
- Do not import the engine (our own bounded reader in a worker) yourself. It loads on demand.
- In Vite's dev server, exclude `@scope/spreadsheet` and add the nested `include` entries. See the README.

```tsx
import { lightRenderers } from '@scope/react';
import { spreadsheetRenderer } from '@scope/spreadsheet';

export const renderers = [spreadsheetRenderer(), ...lightRenderers];
```

Machine-readable index: `llms.txt` in this package.

<!-- common-mistakes:start -->

## Common mistakes

1. **No `authorize`.** `createFileHandler` has no default-open mode: `authorize(req, op, path)` is required and must return `true` for each request you allow. Check the signed-in user there, and deny `'list'`, `'search'` and `'watch'` to anyone who must not see the whole tree.
2. **No stylesheet.** Import `@scope/workspace/styles.css` once (or `@scope/react/styles.css` when you use `@scope/react` alone). Without it the components render unstyled. It needs a bundler that resolves CSS imports, such as Vite or Next.js.
3. **A non-public import.** Import only from the paths in each package's `exports` map: `@scope/core`, `@scope/core/http`, `@scope/core/memory`, `@scope/react`, `@scope/react/renderers`, `@scope/react/renderer-kit`, the `.` entry of every other package, and the `styles.css` files. Never import from `dist/` or `src/`.
4. **No `'use client'` in Next.js.** The components use state and effects. Put `'use client'` at the top of the file that renders `Workspace`, or import it from a client component.
5. **A Vite config without the worker settings.** When `@scope/spreadsheet` is in the build (it is in the `@scope/workspace` preset; `@scope/pdf` alone does not need it), set `worker: { format: 'es' }`, because the code-split spreadsheet worker makes `vite build` fail without it. In Vite's dev server, also exclude `@scope/pdf` and `@scope/spreadsheet` from `optimizeDeps` so their workers resolve, and add the nested `include` entries for the CommonJS modules the spreadsheet worker imports. The exact lines are in the `@scope/workspace` README.

<!-- common-mistakes:end -->
