# @scope/react: notes for coding agents

React UI for a `FileSystemAdapter`. If the app needs PDF, Word, PowerPoint, spreadsheet, Markdown or code viewers, use `@scope/workspace` instead; it re-exports all of this package.

- Renderer authors import `defineRenderer`, `MATCH_SCORE` and the other kit helpers from `@scope/react/renderer-kit` only.
- Import only from `@scope/react`, `@scope/react/renderers`, `@scope/react/renderer-kit` and `@scope/react/styles.css`.
- Import `@scope/react/styles.css` once, and give `Workspace` a height.
- Create the adapter and the `renderers` array once (module scope, or `useState(() => ...)`). A new identity of either resets the session or the viewer cache.
- Style through `classNames` keyed by part name, the `--fs-*` tokens, and the `data-*` state attributes. Do not target generated class names.
- Do not build paths by concatenating strings. Use `joinPath` and `parentPath` from `@scope/core`.
- In Next.js, put `'use client'` at the top of the file that renders the component.

```tsx
'use client';
import { httpAdapter } from '@scope/core/http';
import { Workspace } from '@scope/react';
import '@scope/react/styles.css';

const adapter = httpAdapter('/api/files');

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} style={{ height: '100vh' }} />;
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
