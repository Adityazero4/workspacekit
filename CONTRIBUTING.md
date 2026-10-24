# Contributing

Thank you for helping. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Setup

You need Node.js 22.19 or later and the pnpm version in `packageManager` in `package.json` (Corepack installs it).

```sh
corepack enable
pnpm install --frozen-lockfile
```

Packages live in `packages/`, runnable examples in `examples/`. Every package builds with tsdown into `dist/`, and the docs checks read `dist`, so build a package before checking its docs.

## Checks

- `pnpm check` is the local gate. It runs the static checks that need no build output (types, ESLint, Prettier, the comment policy, licences, supply chain and the script tests), builds every package, runs the docs checks (agent docs, content, the docs types) and then tests every package in Chromium only, one package and one worker at a time, with no performance suites. It stays light enough for a laptop that is doing other work.
- `pnpm check:full` is for CI only. It adds Firefox and WebKit, the Playwright end-to-end runs for both examples and the docs site, and every performance budget. Do not run it on a laptop: it is heavy enough to freeze one.
- While you iterate, run one package's tests, not the whole suite, for example `pnpm vitest run --project '@workspacekit/core'`, and use `--project '<name>*(chromium)'` for browser projects.
- The script tests are plain Node: `node --test scripts/check-licenses.test.mjs`.

Write the test first and watch it fail for the right reason. Tests use held promises or fake timers, never a sleep to assert that nothing happened, and never the network.

## Code and comment policy

Outside readers will read this code, so write it for them.

- Use descriptive names, small functions (60 lines at most; ESLint enforces it) and focused files.
- No inline comments: if code needs explaining, rename, extract or split it. The one exception is a machine directive such as `eslint-disable`, which needs a reason after `--`.
- Every exported function, hook, component and type has TSDoc with a summary and exactly one `@example`. `pnpm check:comments` enforces it.
- Error messages say what to do next.
- Build paths with `joinPath` and `parentPath` from `@workspacekit/core`, never by string concatenation.
- Style hooks are `data-fs-part` names and the closed list of state attributes. Colours come from `--fs-*` tokens, inside `@layer fs`. A new part, state attribute or token needs a maintainer's agreement first.
- Docs and examples show one way to do each thing: the quick start, public subpaths only, and `@workspacekit/workspace/styles.css`. `pnpm agent-docs` regenerates `llms.txt`, the common-mistakes blocks and the README quick start; `pnpm check:agent-docs` fails when they are stale or a code fence does not typecheck.
- Do not mention any company or product that is not a dependency. `pnpm check:forbidden` scans the tree against a private list; without the list it skips locally, and CI (where `FORBIDDEN_PATTERNS` is a secret) fails if the list is missing.

## Supply chain

The dependency rules are enforced by `pnpm check:supply-chain` and `pnpm check:licenses`.

- Pin every dependency to an exact version.
- A version must be at least 7 days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
- Install scripts are off: `allowBuilds` may hold only explicit refusals (`esbuild: false`). If a tool needs a build script, stop and ask.
- No GPL, AGPL, LGPL or unlicensed production dependency. A dual-licensed or odd licence is checked by hand and added to `ALLOW_LIST` in `scripts/check-licenses.mjs` with the reason. `node scripts/check-licenses.mjs --write` regenerates `THIRD_PARTY_NOTICES.md` and `NOTICE`.
- A release-age exception goes in `supply-chain-exceptions.json` and the exclude lists in `pnpm-workspace.yaml`, with a reason and an expiry within 7 days. A maintainer must approve it, and an expired entry fails the check.

## Adding a renderer

Copy `packages/_template` to `packages/<name>` and follow its README. In short:

1. Rename the package, the part prefix in `src/parts.ts` and the `Template...` exports.
2. Put the engine in `dependencies` and import it only from lazily loaded modules, never from `src/index.ts`.
3. Add the engine to the lazy-load assertion in `test/build.test.ts` and to `.size-limit.js`, and set the budget.
4. Put the CSS in `src/styles.css`, inside `@layer fs`, flat (no nesting), using only `--fs-*` tokens.
5. Create the renderer object once at module level, and give the package a README, an `AGENTS.md` and an `llms.txt`.
6. Add the package to the preset's `allRenderers()` in `@workspacekit/workspace`, and to `PUBLIC_PACKAGES` in `scripts/agent-docs.mjs`.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/), such as `fix(core): refuse an empty name`. Keep a pull request to one change, say how you tested it, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice. Code owners review changes to the supply-chain gate and the workflows.
