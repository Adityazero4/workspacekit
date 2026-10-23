# @scope/workspace: notes for coding agents

The default way to put a file workspace in a React app: `Workspace` with every renderer (PDF, Word, PowerPoint, spreadsheets, Markdown, code, text, images, media), plus all of `@scope/react`. Pair it with `@scope/server` on the server.

- Import from `@scope/workspace`, `@scope/workspace/styles.css`, and `@scope/core/http` or `@scope/core/memory` for the adapter. Everything in `@scope/react` is re-exported here, so do not also install it as a peer.
- Import `@scope/workspace/styles.css` once. Never import the per-package stylesheets next to it.
- `Workspace` fills its parent. Give the parent a height.
- Create the adapter and any `allRenderers(...)` result once (module scope, or `useState(() => ...)`).
- To configure one renderer, pass its options to `allRenderers({ pdf, spreadsheet, code, ... })`. Do not rebuild the renderer array by hand; the order decides which renderer wins.
- In Vite (7 or 8), set `worker: { format: 'es' }`, and for the dev server exclude `@scope/pdf` and `@scope/spreadsheet` from `optimizeDeps` and add the nested `include` entries from the README.
- In Next.js, put `'use client'` at the top of the file that renders `Workspace`.

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

Machine-readable index: `llms.txt` in this package.

<!-- common-mistakes:start -->

## Common mistakes

1. **No `authorize`.** `createFileHandler` has no default-open mode: `authorize(req, op, path)` is required and must return `true` for each request you allow. Check the signed-in user there, and deny `'list'`, `'search'` and `'watch'` to anyone who must not see the whole tree.
2. **No stylesheet.** Import `@scope/workspace/styles.css` once (or `@scope/react/styles.css` when you use `@scope/react` alone). Without it the components render unstyled. It needs a bundler that resolves CSS imports, such as Vite or Next.js.
3. **A non-public import.** Import only from the paths in each package's `exports` map: `@scope/core`, `@scope/core/http`, `@scope/core/memory`, `@scope/react`, `@scope/react/renderers`, `@scope/react/renderer-kit`, the `.` entry of every other package, and the `styles.css` files. Never import from `dist/` or `src/`.
4. **No `'use client'` in Next.js.** The components use state and effects. Put `'use client'` at the top of the file that renders `Workspace`, or import it from a client component.
5. **A Vite config without the worker settings.** When `@scope/spreadsheet` is in the build (it is in the `@scope/workspace` preset; `@scope/pdf` alone does not need it), set `worker: { format: 'es' }`, because the code-split spreadsheet worker makes `vite build` fail without it. In Vite's dev server, also exclude `@scope/pdf` and `@scope/spreadsheet` from `optimizeDeps` so their workers resolve, and add the nested `include` entries for the CommonJS modules the spreadsheet worker imports. The exact lines are in the `@scope/workspace` README.

<!-- common-mistakes:end -->
