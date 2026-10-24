import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { TEST_AGENT_INTERVAL_MS } from '../lib/testAgent';

const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const AGENT_WAIT = { timeout: 15_000 };

const GALLERY_RENDERERS = [
  { tab: 'PDF', part: 'pdf-viewer' },
  { tab: 'Spreadsheet', part: 'sheet-viewer' },
  { tab: 'Markdown', part: 'md-viewer' },
  { tab: 'Code', part: 'code-viewer' },
  { tab: 'Image', part: 'image-viewer' },
] as const;

interface AgentProbe {
  writes: number;
  isRunning: boolean;
}

const treeRow = (page: Page, name: string) =>
  page.locator('[role=treeitem]', {
    has: page.locator('[data-fs-part=tree-row-label]', { hasText: new RegExp(`^${name}$`) }),
  });

async function readProbe(page: Page): Promise<AgentProbe> {
  await page
    .waitForFunction(() => '__docsAgent' in window, undefined, AGENT_WAIT)
    .catch(() => {
      throw new Error('window.__docsAgent is missing: build the site with NEXT_PUBLIC_DOCS_TEST=1');
    });
  return page.evaluate(() => (window as unknown as { __docsAgent: AgentProbe }).__docsAgent);
}

const writesOf = async (page: Page): Promise<number> => (await readProbe(page)).writes;

async function expectNoWritesFor(page: Page, steps: number): Promise<void> {
  const before = await writesOf(page);
  const changed = page.waitForFunction(
    (count) => (window as unknown as { __docsAgent: AgentProbe }).__docsAgent.writes !== count,
    before,
    { timeout: steps * TEST_AGENT_INTERVAL_MS },
  );
  await expect(changed).rejects.toThrow(/Timeout/);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: { run: () => Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }> };
      }
    ).axe.run();
    return result.violations.map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
    );
  });
  expect(violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the landing demo renders the sample files', async ({ page }) => {
  await expect(treeRow(page, 'README.md')).toBeVisible();
});

test('within the agent interval a new file appears with a marker', async ({ page }) => {
  await expect(treeRow(page, 'notes')).toHaveAttribute('data-changed-below', '', AGENT_WAIT);
  await treeRow(page, 'notes').click();
  await expect(treeRow(page, 'plan.md')).toBeVisible();
});

for (const { tab, part } of GALLERY_RENDERERS) {
  test(`the ${tab} gallery tab opens its renderer`, async ({ page }) => {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.locator('#gallery-panel').locator(`[data-fs-part=${part}]`)).toBeVisible(AGENT_WAIT);
  });
}

test('after navigating away the agent makes no further writes', async ({ page }) => {
  await expect.poll(() => writesOf(page), AGENT_WAIT).toBeGreaterThanOrEqual(2);
  await page.getByRole('link', { name: 'Documentation' }).first().click();
  await expect(page).toHaveURL(/\/docs\/?$/);
  await expect.poll(async () => (await readProbe(page)).isRunning).toBe(false);
  await expectNoWritesFor(page, 3);
});

test('the agent writes only while the demo is on screen', async ({ page }) => {
  await expect.poll(() => writesOf(page), AGENT_WAIT).toBeGreaterThanOrEqual(2);
  await page.locator('#gallery-heading').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await readProbe(page)).isRunning).toBe(false);
  await expectNoWritesFor(page, 3);
  const whileHidden = await writesOf(page);
  await page.locator('#demo-heading').scrollIntoViewIfNeeded();
  await expect.poll(() => writesOf(page), AGENT_WAIT).toBeGreaterThan(whileHidden);
});

test('the site loads nothing from another origin', async ({ page, baseURL }) => {
  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  await page.goto('/');
  await expect(treeRow(page, 'README.md')).toBeVisible();
  for (const { tab, part } of GALLERY_RENDERERS) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.locator('#gallery-panel').locator(`[data-fs-part=${part}]`)).toBeVisible(AGENT_WAIT);
  }
  const foreign = requestedUrls.filter((url) => {
    const { protocol, origin } = new URL(url);
    return !['data:', 'blob:'].includes(protocol) && origin !== new URL(baseURL!).origin;
  });
  expect(foreign).toEqual([]);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe finds no violations in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(treeRow(page, 'README.md')).toBeVisible();
    await expectNoAxeViolations(page);
  });
}
