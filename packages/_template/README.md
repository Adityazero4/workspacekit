# Renderer package template

The skeleton every renderer package (`@scope/pdf`, `@scope/code`, …) starts from. It is a private workspace
package, so `pnpm check` builds, tests, lints and size-checks it like a real one; it is never published.

To start a package, copy this folder and then:

1. Rename the package in `package.json`, the `template-` part prefix in `src/parts.ts`, and the
   `Template…` exports.
2. Add the engine to `dependencies` and import it only from the lazily loaded modules
   (`TemplateText.tsx` here), never from `src/index.ts` or anything it imports statically.
3. In `test/build.test.ts`, add the engine's specifier (such as `'pdfjs-dist'`) to the
   `assertEngineLoadsLazily` cases.
4. In `.size-limit.js`, add the engine to `peersAndEnginesMeasuredElsewhere`, so the budget measures only
   our own code, and set the package's budget.
5. Add the package's CSS as `src/styles.css` in `@layer fs`, using only `--fs-*` tokens, and export it as
   `./styles.css`.
   Shipped CSS has no nesting (Ruling P4-6): write it flat, or flatten it at build time with `postcss` and
   `postcss-nesting`, and add `assertNoNestedRules` from `scripts/css-nesting.mjs` to `test/build.test.ts`.
6. Create the renderer object once, at module level: the viewer caches each renderer's loaded component by
   the object's identity.
