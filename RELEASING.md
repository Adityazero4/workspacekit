# Releasing

A security checklist for maintainers, to complete before the first publish and to re-read for every release.

## Publishing

- [ ] Claim the npm scope (organisation) before publishing any package, so no one else can publish under it.
- [ ] Publish only from CI, with npm trusted publishing (OIDC) and `--provenance`. Never use a long-lived `NPM_TOKEN`.
- [ ] The npm organisation and every maintainer account have 2FA on, and the packages require 2FA to publish.
- [ ] Every GitHub Action is pinned to a full commit SHA, with the tag in a trailing comment.
- [ ] Workflows set `permissions: {}` at the top and grant each job only what it needs; only `release.yml`'s `publish` job gets `id-token: write`, and it runs in an environment (`check:supply-chain` enforces both).
- [ ] `main` and release tags are protected (required reviews and checks, no force pushes, no tag deletion).
- [ ] Branch protection on `main` requires code-owner review, so a pull request cannot approve changes to the security gate on its own.
- [ ] When the packages stop being `private`, each `package.json` gets `publishConfig` with `access: public` and `provenance: true`.

## Cutting a release

`release.yml` runs when a `v*` tag is pushed, in three jobs:

1. `check` confirms the tag matches every public package's name and version (`scripts/release.mjs check`) and that the tagged commit is on `main`. It then runs `pnpm check:full` and `check:forbidden`.
2. `pack` builds, packs and audits the tarballs (`scripts/check-pack.mjs --out`), hashes them and uploads them. It has no `id-token`, so the dependencies it installs and runs can never obtain a publish credential.
3. `publish` waits for approval in the `npm` environment. It installs nothing from the lockfile: it installs npm 11.21.1, checked against its published sha512, and downloads the tarballs. It checks their hashes against `pack`'s and that they are exactly the 12 public packages at the tag's version. It then publishes them, skipping any version already on npm, so a failed run can simply be re-run.

A tag push runs the `release.yml` of the tagged commit, so the gates that matter live in the repository settings, not in the workflow:

- [ ] A tag ruleset for `v*` lets only you create tags, and forbids updating or deleting them.
- [ ] The `npm` environment has yourself as a required reviewer. Its deployment rule allows only selected tags matching `v*`, so no branch can reach it.
- [ ] The repository is public before the first tag. npm attaches provenance only to packages published from a public repository, and `--provenance` from a private one makes the publish fail.

For each release:

- [ ] One reviewed commit sets every public package to the release version, with `"private": false` and `"publishConfig": { "access": "public", "provenance": true }`. `RELEASE_TAG=v0.1.0 node scripts/release.mjs check` must print nothing.
- [ ] Tag that commit on `main` and push the tag: `git tag v0.1.0 && git push origin v0.1.0`. A version with `-` (such as `0.2.0-rc.1`) is published under the `next` dist-tag, never `latest`.
- [ ] Approve the `publish` job in the Actions tab once `check` and `pack` are green.

### The first publish

npm configures a trusted publisher in a package's settings, so the package must exist first. The first release therefore uses a short-lived token, once. The `workspacekit` npm organisation must exist before it (see Publishing above).

- [ ] On npmjs.com, create a granular access token with read and write access to the `@workspacekit` scope only, expiring in 7 days. If your account requires 2FA for publishing, the token must be allowed to bypass it, because CI cannot answer a 2FA prompt; otherwise the publish fails with `EOTP`.
- [ ] Add it as the `NPM_TOKEN` secret of the `npm` environment (not as a repository secret), then cut the release as above.
- [ ] For each of the 12 packages, open its settings on npmjs.com and add a trusted publisher:
  - GitHub Actions;
  - owner `Adityazero4`, repository `workspacekit`;
  - workflow `release.yml`, environment `npm`.

  A new trusted publisher must complete a publish within 2 days, so set these up close to the next release.

- [ ] Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. From then on, `release.mjs` publishes through OIDC.
- [ ] In each package's settings, require two-factor authentication and disallow tokens.

## Dependencies

- [ ] Dependabot (or Renovate) runs with a 7-day cooldown, matching `minimumReleaseAge` in `pnpm-workspace.yaml`. Dependabot security updates ignore the cooldown, so review those pull requests by hand.
- [ ] Remove every expired exception from `supply-chain-exceptions.json` and the exclude lists in `pnpm-workspace.yaml`; `pnpm check:supply-chain` fails on an expired release-age entry.
- [ ] Before the first publish, remove every release-age exception, then run `pnpm install --frozen-lockfile`: it must pass with no exception left, which proves every locked version is older than 7 days.
- [ ] Re-run `pnpm security:audit` (`pnpm audit --audit-level=moderate`) before the first publish. It needs the network, so it is not part of `pnpm check`.

## Verification

- [ ] `pnpm check:full` passes in CI: all three browsers and every perf budget. CI runs its parts as parallel jobs, and the `check` job, which branch protection requires, passes only when every one of them succeeded. CI sets `PERF_BUDGET_SCALE=2`, because shared runners are slower than a developer machine and vary from run to run: the same commit has measured the 1M-row cold render at 559 ms on one run and 783 ms on another. Firefox, the slowest browser, runs its unit tests in three shards. Locally the budgets apply as written; raise the scale only for slow hardware, never to hide a regression. The local `pnpm check` runs Chromium only, one test worker and one package at a time, and no perf suites, so it stays light enough for a laptop; the full run is too heavy to share a machine with other work.

- [ ] Build the docs site again without `NEXT_PUBLIC_DOCS_TEST` before deploying it: `pnpm test:e2e:docs` writes a test build (with the test hooks) into `apps/docs/out`, and that folder must not be what you upload.

## Once the repository is on GitHub

- [ ] Add the private forbidden-strings list as the `FORBIDDEN_PATTERNS` secret for CI; `check:forbidden` fails in CI without it. `ci.yml` gives it only to the step that runs `check:forbidden`. GitHub withholds secrets from pull requests opened from forks, so that step is skipped for them and runs again on the push to `main`.
- [ ] The docs site deploys from Vercel: the project's root directory is `apps/docs`, whose `vercel.json` builds the packages and the site, and `NEXT_PUBLIC_SITE_URL` is set to https://docs-ashy-alpha.vercel.app. Vercel deploys every push to `main` independently of CI, so docs from a commit whose CI failed still reach the site.

- [ ] Enable Dependabot alerts and Dependabot security updates.
- [ ] Enable private vulnerability reporting (`SECURITY.md` points reporters at it).
- [ ] Enable secret scanning with push protection.
- [ ] Optional: install Socket.dev or a similar install-time malware alert.
