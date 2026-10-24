# next-agent-workspace

A Next.js app that serves a folder on disk through `@workspacekit/server` and shows it in the workspace UI. A fake agent writes into the folder from a separate process, and the workspace shows its changes live.

- `app/api/files/[...path]/route.ts` is the file service: `createFileHandler` over `nodeFsStore(AGENT_WORKSPACE_DIR)`.
- `app/page.tsx` is `<Workspace adapter={httpAdapter('/api/files')} />`.
- `scripts/agent.mjs` creates, edits, renames and deletes files under `AGENT_WORKSPACE_DIR` with `node:fs` only. Changes made outside the handler reach the page as someone else's changes, so changed files get a marker and Follow mode can open them.

<!-- monorepo-only -->

```sh
mkdir workspace
AGENT_WORKSPACE_DIR=$PWD/workspace pnpm --filter @workspacekit/example-next-agent-workspace dev
AGENT_WORKSPACE_DIR=$PWD/workspace pnpm --filter @workspacekit/example-next-agent-workspace agent
```

<!-- /monorepo-only -->
<!-- starter-only

```sh
npm install
mkdir workspace
AGENT_WORKSPACE_DIR=$PWD/workspace npm run dev
AGENT_WORKSPACE_DIR=$PWD/workspace npm run agent
```

-->

Open http://127.0.0.1:3000, switch on "Follow agent changes" in the toolbar and watch. `node scripts/agent.mjs --once` makes a single change and exits.

## Sign-in

`authorize` has no default: every request is refused unless `isSignedIn(req)` in `lib/auth.ts` says yes. Here it accepts an HttpOnly cookie holding a random per-process token, which `proxy.ts` hands to the page in development only. A production build serves no cookie, so every request gets a 403 until you replace `isSignedIn`. If you set `AGENT_WORKSPACE_TOKEN`, that token is required instead and is never handed to the browser; a blank value is ignored.

To use real authentication, change only `isSignedIn` in `lib/auth.ts`: check your session cookie or bearer token there, and delete `proxy.ts`. If one principal may see only part of the tree, also refuse the `list`, `search` and `watch` operations in `authorize` for that principal. Their results are not filtered per entry.

<!-- monorepo-only -->

## Tests

```sh
pnpm test:e2e:next-agent-workspace
```

This runs `next build` and `next start` against a temporary seeded folder, then drives the page in Chromium. It is part of `pnpm check:full`; `pnpm check` only type-checks this example.

`tsconfig.json` is self-contained. `tsconfig.monorepo.json` (source path mappings for this repository's `typecheck`) only works inside the monorepo; drop it when copying the example.

<!-- /monorepo-only -->

The fake agent writes only under `AGENT_WORKSPACE_DIR/agent`, using fixed paths. It does not guard against an `agent` folder that is a symlink pointing elsewhere, so point `AGENT_WORKSPACE_DIR` at a folder you own.
