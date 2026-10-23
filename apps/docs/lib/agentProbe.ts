import type { MemoryAdapter } from '@scope/core/memory';
import { DEFAULT_AGENT_SCRIPT, type AgentStep } from '@scope/demo-kit';
import { TEST_AGENT_INTERVAL_MS } from './testAgent';

/**
 * What a test build exposes on `window.__docsAgent`: how many changes the agent announced and whether it
 * is running now.
 *
 * @example
 * const probe: AgentProbe = { writes: 0, isRunning: false };
 */
export interface AgentProbe {
  writes: number;
  isRunning: boolean;
}

declare global {
  interface Window {
    __docsAgent?: AgentProbe;
  }
}

const IS_TEST_BUILD = process.env.NEXT_PUBLIC_DOCS_TEST === '1';
const TEST_SCRIPT_REPEATS = 200;

if (IS_TEST_BUILD && typeof window !== 'undefined') window.__docsAgent ??= { writes: 0, isRunning: false };

/**
 * The pause between agent steps: short in test builds, and `undefined` (the agent's own default) otherwise.
 *
 * @example
 * simulateAgent(adapter, { signal, intervalMs: AGENT_INTERVAL_MS });
 */
export const AGENT_INTERVAL_MS: number | undefined = IS_TEST_BUILD ? TEST_AGENT_INTERVAL_MS : undefined;

/**
 * The agent script: the default one, repeated many times in test builds so it outlasts a test.
 *
 * @example
 * simulateAgent(adapter, { signal, script: AGENT_SCRIPT });
 */
export const AGENT_SCRIPT: AgentStep[] | undefined = IS_TEST_BUILD
  ? Array.from({ length: TEST_SCRIPT_REPEATS }, () => DEFAULT_AGENT_SCRIPT).flat()
  : undefined;

function probe(): AgentProbe {
  window.__docsAgent ??= { writes: 0, isRunning: false };
  return window.__docsAgent;
}

/**
 * In test builds, counts every change the agent announces on `adapter`; does nothing otherwise.
 *
 * @example
 * countAgentWrites(adapter);
 */
export function countAgentWrites(adapter: MemoryAdapter): void {
  if (!IS_TEST_BUILD) return;
  const announce = adapter.emit.bind(adapter);
  adapter.emit = (events) => {
    probe().writes += 1;
    announce(events);
  };
}

/**
 * In test builds, records whether the agent is running; does nothing otherwise.
 *
 * @example
 * markAgentRunning(true);
 */
export function markAgentRunning(isRunning: boolean): void {
  if (IS_TEST_BUILD) probe().isRunning = isRunning;
}
