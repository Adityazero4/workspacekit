import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';

const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const AGENT_WAIT = { timeout: 15_000 };

const treeRow = (page: Page, name: string) =>
  page.locator('[role=treeitem]', {
    has: page.locator('[data-fs-part=tree-row-label]', { hasText: new RegExp(`^${name}$`) }),
  });

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as { axe: { run: () => Promise<{ violations: { id: string }[] }> } }
    ).axe.run();
    return result.violations.map((violation) => violation.id);
  });
  expect(violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the workspace renders the sample files', async ({ page }) => {
  await expect(treeRow(page, 'README.md')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a folder' })).toBeVisible();
});

test('turning the agent on makes a new file appear with a marker', async ({ page }) => {
  await page.getByLabel('Simulated agent').check();
  await expect(treeRow(page, 'notes')).toHaveAttribute('data-changed-below', '', AGENT_WAIT);
  await treeRow(page, 'notes').click();
  await expect(treeRow(page, 'plan.md')).toBeVisible();
});

test('an agent edit to the open file updates the viewer in place', async ({ page }) => {
  await treeRow(page, 'README.md').click();
  const viewer = page.locator('[data-fs-part=md-viewer]');
  await expect(viewer).toContainText('Demo project', AGENT_WAIT);
  await expect(viewer).not.toContainText('Updated by the agent');
  await viewer.evaluate((element) => {
    (element as HTMLElement & { survivedTheEdit?: boolean }).survivedTheEdit = true;
  });
  await page.getByLabel('Simulated agent').check();
  await expect(viewer).toContainText('Updated by the agent', AGENT_WAIT);
  const sameNode = await viewer.evaluate(
    (element) => (element as HTMLElement & { survivedTheEdit?: boolean }).survivedTheEdit === true,
  );
  expect(sameNode).toBe(true);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe finds no violations in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await treeRow(page, 'README.md').click();
    await expect(page.locator('[data-fs-part=md-viewer]')).toContainText('Demo project', AGENT_WAIT);
    await expectNoAxeViolations(page);
  });
}
