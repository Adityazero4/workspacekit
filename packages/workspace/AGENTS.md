# @workspacekit/workspace: notes for coding agents

The default way to put a file workspace in a React app: `Workspace` with every renderer (PDF, Word, PowerPoint, spreadsheets, Markdown, code, text, images, media), plus all of `@workspacekit/react`. Pair it with `@workspacekit/server` on the server.

- Import from `@workspacekit/workspace`, `@workspacekit/workspace/styles.css`, and `@workspacekit/core/http` or `@workspacekit/core/memory` for the adapter. Everything in `@workspacekit/react` is re-exported here, so do not also install it as a peer.
- Import `@workspacekit/workspace/styles.css` once. Never import the per-package stylesheets next to it.
- `Workspace` fills its parent. Give the parent a height.
- Create the adapter and any `allRenderers(...)` result once (module scope, or `useState(() => ...)`).
- To configure one renderer, pass its options to `allRenderers({ pdf, spreadsheet, code, ... })`. Do not rebuild the renderer array by hand; the order decides which renderer wins.
- In Vite (7 or 8), set `worker: { format: 'es' }`, and for the dev server exclude `@workspacekit/pdf` and `@workspacekit/spreadsheet` from `optimizeDeps` and add the nested `include` entries from the README.
- In Next.js, put `'use client'` at the top of the file that renders `Workspace`.

```tsx
// page.tsx
'use client';
import { Workspace } from '@workspacekit/workspace';
import { httpAdapter } from '@workspacekit/core/http';
import '@workspacekit/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
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
