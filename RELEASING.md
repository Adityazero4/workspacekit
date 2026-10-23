# Releasing

A security checklist for maintainers, to complete before the first publish and to re-read for every release.

## Publishing

- [ ] Publish only from CI, with npm trusted publishing (OIDC) and `--provenance`. Never use a long-lived `NPM_TOKEN`.
- [ ] The npm organisation and every maintainer account have 2FA on, and the packages require 2FA to publish.
- [ ] Every GitHub Action is pinned to a full commit SHA, with the tag in a trailing comment.
- [ ] Workflows set `permissions: {}` at the top and grant each job only what it needs; only the publish job gets `id-token: write`.
- [ ] `main` and release tags are protected (required reviews and checks, no force pushes, no tag deletion).
- [ ] Branch protection on `main` requires code-owner review, so a pull request cannot approve changes to the security gate on its own.
- [ ] Replace `@OWNER` in `.github/CODEOWNERS` with the maintainers' GitHub user or team. `pnpm check:supply-chain --release` (and the check in CI, where `CI=true`) fails while the placeholder is there; a plain local `pnpm check` does not.
- [ ] When the packages stop being `private`, each `package.json` gets `publishConfig` with `access: public` and `provenance: true`.

## Dependencies

- [ ] Dependabot (or Renovate) runs with a 7-day cooldown, matching `minimumReleaseAge` in `pnpm-workspace.yaml`. Dependabot security updates ignore the cooldown, so review those pull requests by hand.
- [ ] Remove every expired exception from `supply-chain-exceptions.json` and the exclude lists in `pnpm-workspace.yaml`; `pnpm check:supply-chain` fails on an expired release-age entry.
- [ ] Before the first publish, remove every release-age exception, then run `pnpm install --frozen-lockfile`: it must pass with no exception left, which proves every locked version is older than 7 days.
- [ ] Re-run `pnpm security:audit` (`pnpm audit --audit-level=moderate`) before the first publish. It needs the network, so it is not part of `pnpm check`.

## Verification

- [ ] `pnpm check:full` passes in CI: all three browsers and every perf budget. The local `pnpm check` runs Chromium only, two workers at a time, and no perf suites, so it stays light enough for a laptop; the full run is too heavy to share a machine with other work.

## Once the repository is on GitHub

- [ ] Enable Dependabot alerts and Dependabot security updates.
- [ ] Enable private vulnerability reporting (`SECURITY.md` points reporters at it).
- [ ] Enable secret scanning with push protection.
- [ ] Optional: install Socket.dev or a similar install-time malware alert.
