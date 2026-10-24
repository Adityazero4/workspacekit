import type { MemoryAdapter } from '@workspacekit/core/memory';

/**
 * One thing the simulated agent does: `create` and `edit` write `content` to `path`, `rename` moves `path`
 * to `to`, and `delete` removes `path`.
 *
 * @example
 * ```ts
 * const step: AgentStep = { kind: 'create', path: 'notes/plan.md', content: '# Plan\n' };
 * ```
 */
export interface AgentStep {
  kind: 'create' | 'edit' | 'rename' | 'delete';
  path: string;
  to?: string;
  content?: string;
}

/**
 * Options of `simulateAgent`. `signal` stops the agent, `intervalMs` is the pause before each step, and
 * `script` replaces `DEFAULT_AGENT_SCRIPT`, and
 * `onError` hears about the step that failed (the agent is silent about failures by default).
 *
 * @example
 * ```ts
 * const options: SimulateAgentOptions = { signal: controller.signal, intervalMs: 2000 };
 * ```
 */
export interface SimulateAgentOptions {
  signal: AbortSignal;
  intervalMs?: number;
  script?: AgentStep[];
  onError?: (error: unknown) => void;
}

/**
 * What the agent does when `simulateAgent` gets no `script`: it writes a plan, edits the README and the
 * source, then creates, renames and deletes a scratch file. It only touches paths in `sampleFiles()`.
 *
 * @example
 * ```ts
 * simulateAgent(adapter, { signal, script: DEFAULT_AGENT_SCRIPT.slice(0, 2) });
 * ```
 */
export const DEFAULT_AGENT_SCRIPT: AgentStep[] = [
  { kind: 'create', path: 'notes/plan.md', content: '# Plan\n\n1. Read the README\n2. Tidy the source\n' },
  { kind: 'edit', path: 'README.md', content: '# Demo project\n\nUpdated by the agent.\n' },
  {
    kind: 'edit',
    path: 'src/index.ts',
    content: 'export function greet(name: string): string {\n  return `Hi, ${name}!`;\n}\n',
  },
  { kind: 'create', path: 'scratch.txt', content: 'temporary notes\n' },
  { kind: 'rename', path: 'scratch.txt', to: 'notes/todo.txt' },
  { kind: 'delete', path: 'notes/todo.txt' },
];

const AGENT_ACTOR = 'agent';
const DEFAULT_INTERVAL_MS = 1500;

async function performStep(adapter: MemoryAdapter, step: AgentStep): Promise<void> {
  if (step.kind === 'delete') await adapter.delete!(step.path);
  else if (step.kind === 'rename') await adapter.move!(step.path, step.to ?? step.path);
  else await adapter.write!(step.path, step.content ?? '');
}

function pauseUnlessAborted(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resume) => {
    if (signal.aborted) return resume();
    const stop = (): void => {
      clearTimeout(timer);
      resume();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resume();
    }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function runScript(agent: MemoryAdapter, steps: AgentStep[], options: SimulateAgentOptions) {
  const { signal, intervalMs = DEFAULT_INTERVAL_MS } = options;
  for (const step of steps) {
    await pauseUnlessAborted(intervalMs, signal);
    if (signal.aborted) return;
    await performStep(agent, step);
  }
}

/**
 * Plays a script of file changes against a memory adapter, one step per `intervalMs`, as if an agent were
 * working in the project. Each change is written through `adapter.withActor('agent')`, so it gives one
 * event with `actor: 'agent'` (plus one for each folder it creates), and a workspace shows it as someone
 * else's change, with a marker and follow mode, rather than as the user's own write. It stops for good when
 * `signal` aborts (a step whose write has already landed still counts) and when a step fails, such as
 * deleting a path that is gone; the failure goes to `onError`.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * simulateAgent(createMemoryAdapter({ files: sampleFiles() }), { signal: controller.signal });
 * ```
 */
export function simulateAgent(adapter: MemoryAdapter, options: SimulateAgentOptions): void {
  runScript(adapter.withActor(AGENT_ACTOR), options.script ?? DEFAULT_AGENT_SCRIPT, options).catch(
    options.onError ?? (() => undefined),
  );
}
