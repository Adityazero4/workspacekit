import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_URL = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:4173';
const VIEWPORT = { width: 1280, height: 800 };
const COLOR_SCHEMES = ['light', 'dark'];
const OUTPUT_FOLDER = fileURLToPath(new URL('../docs/assets/', import.meta.url));
const VITE_EXAMPLE = fileURLToPath(new URL('../examples/vite-memory/package.json', import.meta.url));
const README_ROW = '[role=treeitem]:has([data-fs-part=tree-row-label]:text-is("README.md"))';
const MARKDOWN_VIEWER = '[data-fs-part=md-viewer]';

/**
 * Takes `workspace-light.png` and `workspace-dark.png` in `docs/assets/` with Chromium, from the Vite memory
 * example served at `SCREENSHOT_URL` (default `http://127.0.0.1:4173`). Build and serve it first:
 * `pnpm --filter @workspacekit/example-vite-memory build`, then `pnpm --filter
 * @workspacekit/example-vite-memory preview`.
 *
 * @example
 * await takeScreenshots('http://127.0.0.1:4173');
 */
export async function takeScreenshots(url) {
  const { chromium } = createRequire(VITE_EXAMPLE)('playwright');
  await mkdir(OUTPUT_FOLDER, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const colorScheme of COLOR_SCHEMES) {
      const context = await browser.newContext({ viewport: VIEWPORT, colorScheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.goto(url);
      await page.locator(README_ROW).click();
      await page.locator(MARKDOWN_VIEWER).waitFor();
      await page.screenshot({ path: path.join(OUTPUT_FOLDER, `workspace-${colorScheme}.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

await takeScreenshots(PREVIEW_URL);
