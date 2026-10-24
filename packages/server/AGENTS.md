# @workspacekit/server: notes for coding agents

Serves a directory over HTTP for `httpAdapter` in `@workspacekit/core/http`. Import only from `@workspacekit/server`.

- `authorize` is required and runs for every operation and path. It decides who may do what; the library never decides for you. `isSignedIn` in the example is yours to write and must verify the session or token, not merely check that a header exists.
- `list` and `search` results are not filtered per entry. To scope a user to part of the tree, deny `'list'`, `'search'` and `'watch'`, or hide paths with the store's `exclude`.
- Export the one handler as `GET`, `POST`, `PUT` and `DELETE`.
- `nodeFsStore` resolves every symlink inside its root. Do not widen the root to make a path work.
- Keep this file out of the browser bundle: it needs Node.js.

```ts
// app/api/files/[...path]/route.ts — Next.js; any Fetch-API server works the same way
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req, op, path) => isSignedIn(req), // required; no default-open
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
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
