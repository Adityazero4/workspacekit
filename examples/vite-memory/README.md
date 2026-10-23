# vite-memory

A Vite + React app with the file workspace over sample files kept in memory.

- The "Simulated agent" switch plays a scripted agent against the files: changed files get a marker, and an open file updates in place.
- "Open a folder" (Chromium-based browsers) swaps in `src/fileSystemAccessAdapter.ts`, a `FileSystemAdapter` over a real folder. It has no `watch`, so the workspace polls it.

<!-- monorepo-only -->

```sh
pnpm --filter @scope/example-vite-memory dev
```

<!-- /monorepo-only -->
<!-- starter-only

```sh
npm install
npm run dev
```

-->

`vite.config.ts` holds the dev-server settings from the Vite section of the `@scope/workspace` README.

<!-- monorepo-only -->

## Tests

```sh
pnpm exec vitest run --project 'vite-memory:browser*(chromium)'
pnpm test:e2e:vite-memory
```

The first checks the adapter against the origin-private file system. The second builds the app, serves it with `vite preview` and drives it in Chromium, including an axe pass in light and dark.

`tsconfig.json` is self-contained. `tsconfig.monorepo.json` (source path mappings for this repository's `typecheck`) and `vitest.browser.config.ts` only work inside the monorepo; drop them when copying the example.

<!-- /monorepo-only -->
