# @scope/create-workspace: notes for coding agents

Scaffolds a new project from a tested example. Use it for a new app; to add a workspace to an existing app, follow `@scope/workspace` instead.

- Run `npm create @scope/workspace <directory> -- --template next|vite`. Do not copy files by hand.
- It refuses to generate while a `@scope/*` dependency is private or at `0.0.0`. That is expected before publication; do not work around it by editing the versions.
- It never runs `npm install`. Run it yourself in the new directory.
- The target directory must not exist or must be empty.
- `createWorkspace` is the programmatic form, and `versions` must contain an exact version for every `@scope/*` dependency.

```ts
import { createWorkspace } from '@scope/create-workspace';

await createWorkspace({ template: 'next', directory: 'my-files', versions: { '@scope/workspace': '1.0.0' } });
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
