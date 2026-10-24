# File workspace: notes for coding agents

A React library that gives an app a file tree, search, tabs, upload and viewers over a directory on a server, with live updates when an agent changes files. Docs: https://adityazero4.github.io/workspacekit.

## Quick start

Install with `npm install @workspacekit/workspace @workspacekit/core @workspacekit/server react react-dom`.

On the server, expose a directory. `authorize` is required, and `isSignedIn` is yours to write: it must verify the session or token.

```ts
// app/api/files/[...path]/route.ts — Next.js; any Fetch-API server works the same way
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req, op, path) => isSignedIn(req), // required; no default-open
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

In the browser, render it.

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

`Workspace` fills its parent: give the parent a height, for example `<main style={{ height: '100vh' }}>`.

A minimal `isSignedIn` (a fuller version is in `examples/next-agent-workspace/lib/auth.ts`):

```ts
// lib/auth.ts
import { timingSafeEqual } from 'node:crypto';

const expected = Buffer.from(process.env.AGENT_WORKSPACE_TOKEN ?? '');

export function isSignedIn(request: Request): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  const presented = Buffer.from(/(?:^|;\s*)workspace-token=([^;]*)/.exec(cookie)?.[1] ?? '');
  return expected.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected);
}
```

## Which package

- `@workspacekit/workspace`: the preset. Use this in an app.
- `@workspacekit/server`: the request handler and the directory store.
- `@workspacekit/core`: the adapter contract and the tree store, with `/http` and `/memory`.
- `@workspacekit/react`: the components, when you want only the light renderers or your own.
- `@workspacekit/pdf`, `@workspacekit/docx`, `@workspacekit/pptx`, `@workspacekit/spreadsheet`, `@workspacekit/markdown`, `@workspacekit/code`: one renderer each, already included in the preset.
- `@workspacekit/demo-kit`: sample files and a simulated agent for demos and tests.
- `@workspacekit/create-workspace`: scaffolds a project.

Each package has its own `AGENTS.md` and `llms.txt`.

## Working in this repository

- It is a pnpm workspace. Packages live in `packages/`, runnable examples in `examples/`.
- Every package builds with tsdown into `dist/`. The docs are checked against `dist`, so build a package before checking its docs.
- `pnpm agent-docs` regenerates each package's `llms.txt` and the common-mistakes blocks. `pnpm check:agent-docs` fails when they are stale, an export is missing, or a code fence in a README or `AGENTS.md` does not typecheck. Mark a fence that cannot compile with `// not-compiled: <reason>` as its first line.
- Edit the common mistakes in `docs-src/common-mistakes.md`, never in an `AGENTS.md`.
- Exports get TSDoc with one `@example`. Comments are not allowed inside function bodies.

<!-- common-mistakes:start -->

## Common mistakes

1. **No `authorize`.** `createFileHandler` has no default-open mode: `authorize(req, op, path)` is required and must return `true` for each request you allow. Check the signed-in user there, and deny `'list'`, `'search'` and `'watch'` to anyone who must not see the whole tree. A denied `'watch'` makes the client poll `list`, so deny `'list'` too.
2. **No stylesheet.** Import `@workspacekit/workspace/styles.css` once (or `@workspacekit/react/styles.css` when you use `@workspacekit/react` alone). Without it the components render unstyled. It needs a bundler that resolves CSS imports, such as Vite or Next.js.
3. **A non-public import.** Import only from the paths in each package's `exports` map: `@workspacekit/core`, `@workspacekit/core/http`, `@workspacekit/core/memory`, `@workspacekit/core/docs`, `@workspacekit/react`, `@workspacekit/react/renderers`, `@workspacekit/react/renderer-kit`, the `.` entry of every other package, and the `styles.css` files. Never import from `dist/` or `src/`.
4. **No `'use client'` in Next.js.** The components use state and effects. Put `'use client'` at the top of the file that renders `Workspace`, or import it from a client component.
5. **A Vite config without the worker settings.** When `@workspacekit/spreadsheet` is in the build (it is in the `@workspacekit/workspace` preset; `@workspacekit/pdf` alone does not need it), set `worker: { format: 'es' }`, because the code-split spreadsheet worker makes `vite build` fail without it. In Vite's dev server, also exclude `@workspacekit/pdf` and `@workspacekit/spreadsheet` from `optimizeDeps` so their workers resolve, and add the nested `include` entries for the CommonJS modules the spreadsheet worker imports. The exact lines are in the `@workspacekit/workspace` README.

<!-- common-mistakes:end -->
