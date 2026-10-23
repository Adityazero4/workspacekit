# @scope/server

A Fetch-API request handler that serves a directory to the file workspace, with a required per-request `authorize` callback.

It works in any server that speaks `Request` and `Response`, such as Next.js route handlers, Hono, Bun or Deno. `nodeFsStore` needs Node.js.

## Install

```sh
npm install @scope/server
```

## Entry

`createFileHandler({ store, authorize })` returns a handler. `nodeFsStore(root)` is a store over a directory.

```ts
// app/api/files/[...path]/route.ts — Next.js; any Fetch-API server works the same way
import { createFileHandler, nodeFsStore } from '@scope/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req, op, path) => isSignedIn(req), // required; no default-open
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

`isSignedIn` is yours to write: it must verify the session or token on the request (a cookie, a bearer token), not just check that a header exists. `authorize` runs for every operation and path, and anything but `true` is a 403.

The client side is `httpAdapter('/api/files')` from `@scope/core/http`.

## Use it on its own

The handler is a plain function from `Request` to `Response`, so it runs without a framework:

```ts
import { createFileHandler, nodeFsStore } from '@scope/server';

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
- `actor(request)`: the name of the principal making a request. Live updates tag a change as the user's own only for the same actor.
- `watchHeartbeatMs` and `onError`: the live-update heartbeat and a hook for unexpected failures.
- `nodeFsStore(root, { exclude })`: the directory to serve and names to hide.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/server).
