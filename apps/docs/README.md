# Docs site

The documentation site and landing page, built with Next.js and Fumadocs as a static export (`out/`).

- `pnpm --filter @workspacekit/docs-site build:site` writes the site to `out/`.
- `pnpm --filter @workspacekit/docs-site test:e2e` builds it with the test flag and runs the browser tests.

## Where it is hosted

The site expects to be served from the root of a domain. To serve it from a subpath, set
`NEXT_PUBLIC_BASE_PATH` to that path (for example `/file-workspace`, with a leading slash and no trailing
one) when you build:

```sh
NEXT_PUBLIC_BASE_PATH=/file-workspace pnpm --filter @workspacekit/docs-site build:site
```

Next.js then prefixes every link and asset with it.
