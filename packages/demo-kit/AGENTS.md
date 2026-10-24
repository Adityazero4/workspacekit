# @workspacekit/demo-kit: notes for coding agents

Sample data and a scripted agent for demos and tests. Do not use it in production code paths.

- Import only from `@workspacekit/demo-kit`.
- `simulateAgent` needs a memory adapter from `createMemoryAdapter` in `@workspacekit/core/memory`; it writes through its `withActor('agent')` view. It will not work on `httpAdapter`.
- Always pass an `AbortSignal` and abort it on unmount. In React, start it in an effect and abort in the cleanup.
- The default script only touches paths that exist in `sampleFiles()`. A custom `script` can touch any path.
- Create the adapter once. A new adapter identity resets the workspace.

```ts
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { sampleFiles, simulateAgent } from '@workspacekit/demo-kit';

export const adapter = createMemoryAdapter({ files: sampleFiles() });
export const controller = new AbortController();

simulateAgent(adapter, { signal: controller.signal });
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
