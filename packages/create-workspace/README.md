# @scope/create-workspace

A one-command starter that copies a tested example (Next.js or Vite) into a new folder, with exact `@scope/*` versions.

Until the `@scope/*` packages are published, the command refuses to generate a project: it will not write a starter whose dependencies are private or still at `0.0.0`. That is the publish gate, and the error says which packages are the problem.

## Install

You do not install it. Run it:

```sh
npm create @scope/workspace my-files -- --template vite
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
import { createWorkspace } from '@scope/create-workspace';

await createWorkspace({
  template: 'vite',
  directory: 'my-files',
  versions: { '@scope/workspace': '1.0.0', '@scope/core': '1.0.0' },
});
```

`versions` must give an exact version for every `@scope/*` package the template depends on.

## CSS

None. The generated project imports `@scope/workspace/styles.css` for you.

## Options

- `--template next|vite`: which example to copy. The Next.js one serves a directory through a route handler; the Vite one runs entirely in the browser on sample files.
- `directory`: the folder to create. It must not exist or must be empty.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/create-workspace).
