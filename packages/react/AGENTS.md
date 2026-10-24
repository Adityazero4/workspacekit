# @workspacekit/react: notes for coding agents

React UI for a `FileSystemAdapter`. If the app needs PDF, Word, PowerPoint, spreadsheet, Markdown or code viewers, use `@workspacekit/workspace` instead; it re-exports all of this package.

- Renderer authors import `defineRenderer`, `MATCH_SCORE` and the other kit helpers from `@workspacekit/react/renderer-kit` only.
- Import only from `@workspacekit/react`, `@workspacekit/react/renderers`, `@workspacekit/react/renderer-kit` and `@workspacekit/react/styles.css`.
- Import `@workspacekit/react/styles.css` once, and give `Workspace` a height.
- Create the adapter and the `renderers` array once (module scope, or `useState(() => ...)`). A new identity of either resets the session or the viewer cache.
- Style through `classNames` keyed by part name, the `--fs-*` tokens, and the `data-*` state attributes. Do not target generated class names.
- Do not build paths by concatenating strings. Use `joinPath` and `parentPath` from `@workspacekit/core`.
- In Next.js, put `'use client'` at the top of the file that renders the component.

```tsx
'use client';
import { httpAdapter } from '@workspacekit/core/http';
import { Workspace } from '@workspacekit/react';
import '@workspacekit/react/styles.css';

const adapter = httpAdapter('/api/files');

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} style={{ height: '100vh' }} />;
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
