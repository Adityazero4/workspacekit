# @workspacekit/demo-kit

Sample files and a simulated agent for demos and tests of the file workspace.

The simulated agent writes, edits, renames and deletes files in a memory adapter on a timer, so you can watch live updates without a real agent or server. The docs site and the examples use it. It is not meant for production.

## Install

```sh
npm install --save-dev @workspacekit/demo-kit
```

## Entry

`sampleFiles()` returns a small project to put in a memory adapter. `simulateAgent(adapter, { signal })` starts the agent and stops when the signal aborts.

```ts
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { sampleFiles, simulateAgent } from '@workspacekit/demo-kit';

export const adapter = createMemoryAdapter({ files: sampleFiles() });

const controller = new AbortController();
simulateAgent(adapter, { signal: controller.signal });
```

Call `controller.abort()` to stop it.

## Standalone use

This package has no UI, so it works with any adapter built on `createMemoryAdapter`. Give the agent your own script to control exactly what changes:

```ts
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { simulateAgent, type AgentStep } from '@workspacekit/demo-kit';

const script: AgentStep[] = [
  { kind: 'create', path: 'notes/plan.md', content: '# Plan\n' },
  { kind: 'rename', path: 'notes/plan.md', to: 'notes/done.md' },
];

simulateAgent(createMemoryAdapter(), { signal: new AbortController().signal, script, intervalMs: 500 });
```

## CSS

None. This package ships no styles.

## Options

- `signal`: required. Aborting it stops the agent.
- `intervalMs`: the pause before each step. Default 1500.
- `script`: the steps to run, instead of `DEFAULT_AGENT_SCRIPT`. A step is `create`, `edit`, `rename` or `delete`.
- `onError`: hears about a step that failed. The agent is silent about failures by default.

`DOCS_URL` is the address of the documentation site, shared by the examples and the generated files.

Every export is documented with an example in the [API reference](https://docs-ashy-alpha.vercel.app/api/demo-kit).
