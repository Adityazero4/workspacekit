import type { ChangeEvent } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_AGENT_SCRIPT, sampleFiles, simulateAgent, type AgentStep } from '../src';

const INTERVAL_MS = 100;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function adapterRecordingChanges(): { adapter: MemoryAdapter; changes: string[] } {
  const adapter = createMemoryAdapter({ files: sampleFiles() });
  const changes: string[] = [];
  adapter.watch!((events) => {
    for (const { type, path, actor } of events) if (actor === 'agent') changes.push(`${type} ${path}`);
  });
  return { adapter, changes };
}

test('the default script runs in order, each change announced as the agent', async () => {
  const { adapter, changes } = adapterRecordingChanges();
  simulateAgent(adapter, { signal: new AbortController().signal, intervalMs: INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * DEFAULT_AGENT_SCRIPT.length);
  expect(changes).toEqual([
    'created notes',
    'created notes/plan.md',
    'updated README.md',
    'updated src/index.ts',
    'created scratch.txt',
    'moved notes/todo.txt',
    'deleted notes/todo.txt',
  ]);
  expect(await adapter.stat!('notes/todo.txt', {})).toBeNull();
  expect(await adapter.read('README.md', 'text')).toContain('Updated by the agent');
});

test('a step only runs after its interval', async () => {
  const { adapter, changes } = adapterRecordingChanges();
  simulateAgent(adapter, { signal: new AbortController().signal, intervalMs: INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(changes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(changes).toEqual(['created notes', 'created notes/plan.md']);
});

test('each step gives exactly one event, with the agent as actor', async () => {
  const adapter = createMemoryAdapter({ files: sampleFiles() });
  const events: ChangeEvent[] = [];
  adapter.watch!((batch) => events.push(...batch));
  const script: AgentStep[] = [
    { kind: 'edit', path: 'README.md', content: 'x' },
    { kind: 'rename', path: 'README.md', to: 'GUIDE.md' },
    { kind: 'delete', path: 'GUIDE.md' },
  ];
  simulateAgent(adapter, { signal: new AbortController().signal, intervalMs: INTERVAL_MS, script });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * script.length);
  expect(events.map(({ type, path, actor }) => `${type} ${path} ${actor}`)).toEqual([
    'updated README.md agent',
    'moved GUIDE.md agent',
    'deleted GUIDE.md agent',
  ]);
});

test('aborting stops every later change', async () => {
  const adapter = createMemoryAdapter({ files: sampleFiles() });
  const events: ChangeEvent[] = [];
  adapter.watch!((batch) => events.push(...batch));
  const controller = new AbortController();
  simulateAgent(adapter, { signal: controller.signal, intervalMs: INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  const eventsBeforeAbort = events.length;
  controller.abort();
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * DEFAULT_AGENT_SCRIPT.length);
  expect(events).toHaveLength(eventsBeforeAbort);
});

test('a custom script replaces the default one', async () => {
  const { adapter, changes } = adapterRecordingChanges();
  const script: AgentStep[] = [{ kind: 'delete', path: 'README.md' }];
  simulateAgent(adapter, { signal: new AbortController().signal, intervalMs: INTERVAL_MS, script });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
  expect(changes).toEqual(['deleted README.md']);
});

test('a failing step stops the agent without an unhandled rejection', async () => {
  const { adapter, changes } = adapterRecordingChanges();
  const script: AgentStep[] = [
    { kind: 'delete', path: 'missing.txt' },
    { kind: 'delete', path: 'README.md' },
  ];
  const onError = vi.fn();
  simulateAgent(adapter, { signal: new AbortController().signal, intervalMs: INTERVAL_MS, script, onError });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(changes).toEqual([]);
});

test('a step whose write has landed is announced once even if the abort arrives mid-step', async () => {
  const adapter = createMemoryAdapter({ files: sampleFiles(), latencyMs: INTERVAL_MS });
  const announcements: string[] = [];
  adapter.watch!((events) => {
    for (const { type, path, actor } of events) if (actor === 'agent') announcements.push(`${type} ${path}`);
  });
  const controller = new AbortController();
  simulateAgent(adapter, { signal: controller.signal, intervalMs: INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS + INTERVAL_MS / 2);
  controller.abort();
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * DEFAULT_AGENT_SCRIPT.length * 2);
  expect(announcements).toEqual(['created notes', 'created notes/plan.md']);
});
