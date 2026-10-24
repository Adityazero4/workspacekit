# @workspacekit/core

The framework-free core of the file workspace: the adapter contract, the tree store, paths, naming rules, uploads, and an HTTP client and in-memory adapter.

It has no React and no Node dependency, so it runs in the browser, in a worker and on a server.

## Install

```sh
npm install @workspacekit/core
```

## Entry points

- `@workspacekit/core`: types, `FsError`, path helpers (`joinPath`, `parentPath`, `basename`), `createTreeStore`, `createVisibleRowIndex`, `createUploader` and the drop helpers.
- `@workspacekit/core/http`: `httpAdapter`, a `FileSystemAdapter` that talks to `createFileHandler` from `@workspacekit/server`.
- `@workspacekit/core/memory`: `createMemoryAdapter`, an in-memory adapter for demos and tests.
- `@workspacekit/core/docs`: `DOCS_URL` and `docsLink`, the documentation links the packages' error messages use.

## Use it on its own

`createTreeStore` wraps any `FileSystemAdapter` and subscribes to its `watch` itself. It is compatible with `useSyncExternalStore`.

```ts
import { createTreeStore } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';

const store = createTreeStore(createMemoryAdapter({ files: { 'src/a.ts': 'export {};' } }));
await store.loadFolder('');
await store.rename('src/a.ts', 'b.ts');
console.log(store.getSnapshot().tree);
store.dispose();
```

Talk to a server with `httpAdapter`:

```ts
import { httpAdapter } from '@workspacekit/core/http';

export const adapter = httpAdapter('/api/files', { credentials: 'include' });
```

Build paths with `joinPath` and `parentPath`, never by concatenating strings:

```ts
import { joinPath, parentPath } from '@workspacekit/core';

export const target = joinPath(parentPath('src/a.ts'), 'b.ts');
```

## CSS

None. This package ships no styles.

## Options

- `createTreeStore(adapter, { fetchDepth, root, onError })`: how deep each listing goes (default 2), the folder the store shows, and a callback for load failures.
- `httpAdapter(baseUrl, { fetch, headers, credentials, reconnectDelaysMs, ... })`: a custom `fetch`, request headers (or a function that returns them), and the live-update reconnect backoff.
- `createMemoryAdapter({ files, latencyMs, chunkSize })`: the starting files, an artificial delay, and the upload chunk size.

Every export is documented with an example in the [API reference](https://adityazero4.github.io/workspacekit/api/core).
