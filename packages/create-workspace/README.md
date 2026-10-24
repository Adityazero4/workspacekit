# @workspacekit/create-workspace

A one-command starter that copies a tested example (Next.js or Vite) into a new folder, with exact `@workspacekit/*` versions.

Until the `@workspacekit/*` packages are published, the command refuses to generate a project: it will not write a starter whose dependencies are private or still at `0.0.0`. That is the publish gate, and the error says which packages are the problem.

## Install

You do not install it. Run it:

```sh
npm create @workspacekit/workspace my-files -- --template vite
```

## Entry

```sh
create-workspace [directory] [--template next|vite]
```

The directory defaults to `my-workspace` and the template to `next`. Then:

```sh
cd my-files
npm install
npm run dev
```

## Standalone use

The command is a thin wrapper over `createWorkspace`, which you can call from a script:

```ts
import { createWorkspace } from '@workspacekit/create-workspace';

await createWorkspace({
  template: 'vite',
  directory: 'my-files',
  versions: { '@workspacekit/workspace': '1.0.0', '@workspacekit/core': '1.0.0' },
});
```

`versions` must give an exact version for every `@workspacekit/*` package the template depends on.

## CSS

None. The generated project imports `@workspacekit/workspace/styles.css` for you.

## Options

- `--template next|vite`: which example to copy. The Next.js one serves a directory through a route handler; the Vite one runs entirely in the browser on sample files.
- `directory`: the folder to create. It must not exist or must be empty.

Every export is documented with an example in the [API reference](https://adityazero4.github.io/workspacekit/api/create-workspace).
