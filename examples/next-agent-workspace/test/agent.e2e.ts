import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workspaceDirectory = process.env.AGENT_WORKSPACE_DIR!;
const sessionToken = process.env.AGENT_WORKSPACE_TOKEN!;
const SESSION_COOKIE = 'agent-workspace-session';
const AGENT_WAIT = { timeout: 15_000 };
const AGENT_LOG = 'Agent log\n';

const treeRow = (page: Page, name: string) =>
  page.locator('[role=treeitem]', {
    has: page.locator('[data-fs-part=tree-row-label]', { hasText: new RegExp(`^${name}$`) }),
  });

const runAgentOnce = (): void => {
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'agent.mjs'), '--once'], {
    env: { ...process.env, AGENT_WORKSPACE_DIR: workspaceDirectory },
  });
};

const seedAgentLog = (): void => {
  mkdirSync(join(workspaceDirectory, 'agent'), { recursive: true });
  writeFileSync(join(workspaceDirectory, 'agent', 'log.txt'), AGENT_LOG);
};

test.beforeEach(async ({ page, baseURL }) => {
  rmSync(join(workspaceDirectory, 'agent'), { recursive: true, force: true });
  await page.context().addCookies([{ name: SESSION_COOKIE, value: sessionToken, url: baseURL! }]);
  await page.goto('/');
});

test('the tree lists the seeded files', async ({ page }) => {
  await expect(treeRow(page, 'README.md')).toBeVisible();
  await expect(treeRow(page, 'docs')).toBeVisible();
});

test('a file the agent creates appears with a marker and no reload', async ({ page }) => {
  await expect(treeRow(page, 'README.md')).toBeVisible();
  runAgentOnce();
  const changedFolder = treeRow(page, 'agent');
  await expect(changedFolder).toHaveAttribute('data-changed', '', AGENT_WAIT);
  await changedFolder.click();
  await expect(treeRow(page, 'log.txt')).toBeVisible(AGENT_WAIT);
});

test('follow mode opens the file the agent changes', async ({ page }) => {
  seedAgentLog();
  await page.reload();
  await treeRow(page, 'agent').click();
  await expect(treeRow(page, 'log.txt')).toBeVisible(AGENT_WAIT);
  await page.getByRole('button', { name: 'Follow agent changes' }).click();
  runAgentOnce();
  await expect(page.locator('[data-fs-part=text-editor]')).toContainText('Agent step at', AGENT_WAIT);
});

test('editing a file the agent also edits shows the conflict banner', async ({ page }) => {
  seedAgentLog();
  await page.reload();
  await treeRow(page, 'agent').click();
  await treeRow(page, 'log.txt').click();
  const editor = page.locator('[data-fs-part=text-editor]');
  await expect(editor).toHaveValue(AGENT_LOG, AGENT_WAIT);
  await editor.pressSequentially('my notes');
  runAgentOnce();
  const banner = page.getByRole('alert').filter({ hasText: 'was changed by someone else' });
  await expect(banner).toBeVisible(AGENT_WAIT);
  await expect(banner.getByRole('button', { name: 'Keep mine' })).toBeVisible();
});

test('a request without the session cookie is refused', async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  const response = await anonymous.get('/api/files/list?path=');
  expect(response.status()).toBe(403);
  await anonymous.dispose();
});
