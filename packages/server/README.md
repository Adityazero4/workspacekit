# @workspacekit/server

A Fetch-API request handler that serves a directory to the file workspace, with a required per-request `authorize` callback.

It works in any server that speaks `Request` and `Response`, such as Next.js route handlers, Hono, Bun or Deno. `nodeFsStore` needs Node.js.

## Install

```sh
npm install @workspacekit/server
```

## Entry

`createFileHandler({ store, authorize })` returns a handler. `nodeFsStore(root)` is a store over a directory.

```ts
// app/api/files/[...path]/route.ts — Next.js; any Fetch-API server works the same way
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req, op, path) => isSignedIn(req), // required; no default-open
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

`isSignedIn` is yours to write: it must verify the session or token on the request (a cookie, a bearer token), not just check that a header exists. `authorize` runs for every operation and path, and anything but `true` is a 403.

The client side is `httpAdapter('/api/files')` from `@workspacekit/core/http`.

## Use it on its own

The handler is a plain function from `Request` to `Response`, so it runs without a framework:

```ts
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const handler = createFileHandler({
  store: nodeFsStore('/srv/workspace', { exclude: ['.git', 'node_modules'] }),
  authorize: () => false,
});

export const response = await handler(new Request('http://localhost/api/files/list?path='));
```

`authorize` here denies everything. Replace it with your own check.

## CSS

None. This package ships no styles.

## Options

- `authorize(request, operation, path)`: required. Return `true` to allow. There is no default-open mode.
- `readOnly`: reject every mutating operation.
- `maxUploadBytes`, `maxWriteBytes`, `chunkSize`, `uploadTtlMs`: upload and write limits.
- `maxUploadSessions` (100) and `maxUploadTempBytes` (4 GiB): how many chunked uploads may be unfinished at once, and how many bytes they may keep, declared and written. Past either, the answer is 503 at `upload/init` or 413 for a chunk.
- `uploadTempDir`: a folder you own (mode 0700, one per handler) for chunked uploads, so a restarted server clears what its previous run left. Sessions live only in a `workspacekit-uploads` subfolder the handler creates and marks; nothing else in the folder is touched. By default each handler uses a fresh private temp folder.
- `maxWatchConnections` (100), `watchBufferBytes` (1 MiB) and `watchMaxLifetimeMs` (1 hour): open live-update streams, the bytes each may hold unread before a slow client is disconnected, and how long one stays open. The client reconnects after either.
- `maxUploadSessionsPerActor`, `maxUploadTempBytesPerActor` and `maxWatchConnectionsPerActor` (a quarter of the overall cap): with an `actor` hook, what one principal may hold. Without one, every request is the same actor.
- `maxListDepth` (16) and `maxListEntries` (100,000): the deepest and the largest `list`.
- `maxSearchVisits` (100,000) and `searchTimeoutMs` (5 s): how far a `search` walks before it answers with what it found.
- `actor(request)`: the name of the principal making a request. Live updates tag a change as the user's own only for the same actor.
- `watchHeartbeatMs` and `onError`: the live-update heartbeat and a hook for unexpected failures.
- `nodeFsStore(root, { exclude, searchLimit })`: the directory to serve, names to hide, and the most results one search returns (200).

A path that goes through a symlink inside the root is authorized as itself and as the link's target, and both must allow.

Every export is documented with an example in the [API reference](https://adityazero4.github.io/workspacekit/api/server).
