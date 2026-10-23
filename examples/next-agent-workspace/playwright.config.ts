import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4310;

function seededWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-workspace-'));
  mkdirSync(join(directory, 'docs'));
  writeFileSync(join(directory, 'README.md'), '# Agent workspace\n');
  writeFileSync(join(directory, 'docs', 'guide.txt'), 'A seeded guide.\n');
  return directory;
}

process.env.AGENT_WORKSPACE_DIR ??= seededWorkspace();
process.env.AGENT_WORKSPACE_TOKEN ??= randomUUID();
const workspaceDirectory = process.env.AGENT_WORKSPACE_DIR;
const sessionToken = process.env.AGENT_WORKSPACE_TOKEN;

export default defineConfig({
  testDir: 'test',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { AGENT_WORKSPACE_DIR: workspaceDirectory, AGENT_WORKSPACE_TOKEN: sessionToken },
  },
});
