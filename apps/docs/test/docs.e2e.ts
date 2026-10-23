import { expect, test } from '@playwright/test';

const PAGES = [
  '/docs/',
  '/docs/getting-started/next/',
  '/docs/getting-started/vite/',
  '/docs/concepts/adapter/',
  '/docs/concepts/renderers/',
  '/docs/concepts/actions/',
  '/docs/concepts/policy/',
  '/docs/server/handler/',
  '/docs/server/protocol/',
  '/docs/server/security/',
  '/docs/styling/',
  '/docs/standalone-renderers/',
  '/docs/recipes/s3/',
  '/docs/recipes/custom-adapter/',
  '/docs/recipes/custom-renderer/',
  '/docs/recipes/theming/',
  '/docs/recipes/standalone-pdf/',
  '/docs/recipes/server-route/',
  '/docs/coding-agents/',
  '/api/',
  '/api/core/',
  '/api/react/',
  '/api/workspace/',
] as const;

for (const url of PAGES) {
  test(`${url} renders a heading and no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('h1')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('the recipe pages embed their source files', async ({ page }) => {
  await page.goto('/docs/recipes/s3/');
  await expect(page.getByText('examples/recipes/src/s3Store.ts')).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'export function s3Store' })).toBeVisible();
});

test('the token playground changes the workspace tokens and the CSS it prints', async ({ page }) => {
  await page.goto('/docs/styling/');
  const playground = page.getByTestId('token-playground');
  await playground.scrollIntoViewIfNeeded();
  await playground.locator('input[type=range]').first().fill('4');
  await expect(page.getByTestId('token-css')).toContainText('--fs-radius: 4px');
  await expect(playground.locator('[data-fs-part=workspace]')).toHaveCSS('--fs-radius', '4px');
});

test('the slot playground swaps the empty state', async ({ page }) => {
  await page.goto('/docs/styling/');
  const playground = page.getByTestId('slot-playground');
  await expect(playground.locator('[data-brand-empty]')).toBeVisible();
  await playground.getByLabel('Replace the EmptyState slot').uncheck();
  await expect(playground.locator('[data-brand-empty]')).toHaveCount(0);
});

test('the custom renderer opens run.log with colored lines', async ({ page }) => {
  await page.goto('/docs/concepts/renderers/');
  const demo = page.getByTestId('custom-renderer-demo');
  await demo.getByRole('treeitem', { name: /run\.log/ }).dblclick();
  await expect(demo.getByLabel('Log file')).toContainText('ERROR could not write');
});

test('the protected files offer no delete, and the custom action runs', async ({ page }) => {
  await page.goto('/docs/concepts/actions/');
  const demo = page.getByTestId('actions-demo');
  await demo.getByRole('treeitem', { name: /README\.md/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await demo.getByRole('treeitem', { name: /package\.json/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Ask the agent about this' }).click();
  await expect(page.getByTestId('asked-status')).toContainText('package.json');
});

test('the site publishes llms.txt and llms-full.txt for coding agents', async ({ request }) => {
  const index = await request.get('/llms.txt');
  expect(index.ok()).toBe(true);
  expect(await index.text()).toContain('/docs/coding-agents');
  const full = await request.get('/llms-full.txt');
  expect(full.ok()).toBe(true);
  expect(await full.text()).toContain('createFileHandler');
});
