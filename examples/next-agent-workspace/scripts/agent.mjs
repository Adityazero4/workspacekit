import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INTERVAL_MS = 2000;
const workspaceDirectory = process.env.AGENT_WORKSPACE_DIR;
if (!workspaceDirectory) {
  console.error(
    'Set AGENT_WORKSPACE_DIR to the folder the app serves, for example: AGENT_WORKSPACE_DIR=$PWD/workspace node scripts/agent.mjs',
  );
  process.exit(1);
}

const inWorkspace = (relativePath) => join(workspaceDirectory, relativePath);

function writeFile(relativePath, content) {
  mkdirSync(dirname(inWorkspace(relativePath)), { recursive: true });
  writeFileSync(inWorkspace(relativePath), content);
}

function appendToLog() {
  if (!existsSync(inWorkspace('agent/log.txt'))) writeFile('agent/log.txt', 'Agent log\n');
  appendFileSync(inWorkspace('agent/log.txt'), `Agent step at ${new Date().toISOString()}\n`);
}

const script = [
  () => writeFile('agent/plan.md', '# Plan\n\n1. Read the files\n2. Tidy them up\n'),
  appendToLog,
  () => appendFileSync(inWorkspace('agent/plan.md'), '3. Write the summary\n'),
  () => writeFile('agent/scratch.txt', 'temporary notes\n'),
  () => renameSync(inWorkspace('agent/scratch.txt'), inWorkspace('agent/todo.txt')),
  () => rmSync(inWorkspace('agent/todo.txt')),
];

if (process.argv.includes('--once')) {
  appendToLog();
} else {
  let nextStep = 0;
  setInterval(() => {
    try {
      script[nextStep % script.length]();
    } catch (error) {
      process.stderr.write(`Agent step ${nextStep % script.length} failed: ${String(error)}\n`);
    }
    nextStep += 1;
  }, INTERVAL_MS);
  process.stdout.write(`Agent running against ${workspaceDirectory}; press Ctrl+C to stop.\n`);
}
