# @scope/react bench

A page that renders the full `<Workspace>` over an in-memory tree, and a Playwright runner that measures it in
Chromium. It is not part of the published package (`files` ships `dist` only).

```sh
pnpm --filter @scope/react bench                # every shape at 10k, 100k and 1M files
pnpm --filter @scope/react bench 10000 100000   # only these sizes
```

`run.mjs` builds the page with Vite (production React, React Compiler on, `@scope/core` from source), serves it,
and for each shape (`wide`, `10x100k`, `chains64`) and size opens
`?shape=<shape>&size=<files>`, which renders
`<Workspace adapter={createMemoryAdapter({ files: generateShape(shape, files) })} />`. The tree is generated once
per page and reused across the runs. Every figure is the median of 3 runs:

- **first render**: from `root.render` to the first painted tree row, the first mount in a freshly loaded page (3
  pages), as a user opening the app sees it;
- **heap**: from CDP (`HeapProfiler.collectGarbage`, then `Performance.getMetrics` `JSHeapUsedSize`), before and
  after mounting the workspace. The difference is what the workspace holds; the page total also counts the in-page
  memory adapter, which stands in for a server;
- **expand, fetching**: a fresh workspace with `fetchDepth: 1` per run, so expanding the first top-level folder lists,
  merges and sorts its children;
- **expand and collapse** of that folder once loaded, until its children are painted or gone;
- **scroll**: up to 50 viewports (as many as the open rows fill), one per frame, with the folder open; the run fails
  unless `scrollTop` reached the distance and the rendered rows changed. Frames come from `requestAnimationFrame`
  timestamps, and both `long-animation-frame` and `longtask` entries are counted where supported;
- **rename** and **drag to the root** of the folder's first child. The mounted adapter answers moves after 50 ms,
  as a server would, so these time the optimistic change on screen. The rename round trip records frames through
  the answer and the folder reload that follows;
- **search**: from typing to the first result;
- **5k event burst**: frames over the 3 s after 5,000 `updated` events from an agent under the folder.

Results go to `internal/bench/RESULTS-react.md` (git-ignored). A `## Reference` section already in that file is
kept when the table is rewritten.

The budgets are asserted separately, in `test/scale.browser.test.tsx`, by the `react:perf` Vitest project
(`pnpm test:perf:react`, Chromium only; `CI_SLOW=1` skips it). It shares the scenarios in `scenarios.tsx` with this
page, measures the cold first render by opening this page in a fresh tab through the Vitest server, and reads the
heap from `performance.memory` (Chromium started with `--enable-precise-memory-info` and `--js-flags=--expose-gc`).
Its frame budgets rest on `requestAnimationFrame` gaps only: inside the Vitest iframe no long-animation-frame
entries arrive, so asserting on them could never fail.
