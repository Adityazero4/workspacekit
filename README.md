# File workspace

A React file workspace for apps where people and agents work in the same directory: a virtualized file tree, search, tabs, upload and viewers for common document types, with live updates when an agent changes a file.

![The workspace in light mode, with the file tree beside a rendered Markdown file](docs/assets/workspace-light.png#gh-light-mode-only)
![The workspace in dark mode, with the file tree beside a rendered Markdown file](docs/assets/workspace-dark.png#gh-dark-mode-only)

## Quick start

Install the preset and the server handler:

```sh
npm install @scope/workspace @scope/core @scope/server react react-dom
```

<!-- quick-start:start -->

On the server, expose a directory. `authorize` is required, and `isSignedIn` is yours to write: it must verify the session or token.

```ts
import { createFileHandler, nodeFsStore } from '@scope/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req) => isSignedIn(req),
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

In the browser, render it.

```tsx
'use client';
import { Workspace } from '@scope/workspace';
import { httpAdapter } from '@scope/core/http';
import '@scope/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
```

<!-- quick-start:end -->

`Workspace` fills its parent: give the parent a height, for example `<main style={{ height: '100vh' }}>`.

A minimal `isSignedIn`: it compares a token from a cookie with a secret in constant time. Replace it with your real session or token check; a fuller version is in [`examples/next-agent-workspace/lib/auth.ts`](examples/next-agent-workspace/lib/auth.ts).

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

`nodeFsStore` checks `AGENT_WORKSPACE_DIR` on the first request, so `next build` works without it. `authorize` has no default-open mode: the server refuses every request until you decide who may do what. Import `@scope/workspace/styles.css` once. More in [Common mistakes](AGENTS.md#common-mistakes).

## Packages

| Package                                                | What it is                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [`@scope/workspace`](packages/workspace)               | The preset: `Workspace` with every renderer. Use this in an app. |
| [`@scope/server`](packages/server)                     | A Fetch-API request handler that serves a directory.             |
| [`@scope/core`](packages/core)                         | The adapter contract, the tree store, paths and uploads.         |
| [`@scope/react`](packages/react)                       | The components, when you want only the light renderers.          |
| [`@scope/pdf`](packages/pdf)                           | PDF renderer, drawn by pdf.js.                                   |
| [`@scope/docx`](packages/docx)                         | Word renderer, sanitized before it is shown.                     |
| [`@scope/pptx`](packages/pptx)                         | PowerPoint renderer with virtualized slides.                     |
| [`@scope/spreadsheet`](packages/spreadsheet)           | `.xlsx`, `.csv` and `.tsv` in a virtualized grid.                |
| [`@scope/markdown`](packages/markdown)                 | Editable Markdown with a source mode.                            |
| [`@scope/code`](packages/code)                         | CodeMirror 6 editor for code, configuration and data files.      |
| [`@scope/demo-kit`](packages/demo-kit)                 | Sample files and a simulated agent for demos and tests.          |
| [`@scope/create-workspace`](packages/create-workspace) | Scaffolds a project from a tested example.                       |

The packages are not published yet. Each one has a README, an `AGENTS.md` and an `llms.txt` for coding agents.

## Documentation

- Guides and API reference: https://docs.example.invalid
- Runnable examples: [`examples/`](examples) (a Next.js app with an agent-written directory, a Vite app on the in-memory adapter, and recipes)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)

## Licence

[Apache-2.0](LICENSE). Third-party licences are listed in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
