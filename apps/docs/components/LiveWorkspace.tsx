'use client';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { sampleFiles, simulateAgent } from '@workspacekit/demo-kit';
import { Workspace } from '@workspacekit/workspace';
import '@workspacekit/workspace/styles.css';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceController } from '@workspacekit/react';
import { useSiteTheme } from '../lib/useSiteTheme';
import { AGENT_INTERVAL_MS, AGENT_SCRIPT, countAgentWrites, markAgentRunning } from '../lib/agentProbe';
import { AgentActivity } from './AgentActivity';

function createDemoAdapter(): ReturnType<typeof createMemoryAdapter> {
  const adapter = createMemoryAdapter({ files: sampleFiles() });
  countAgentWrites(adapter);
  return adapter;
}

function useIsVisible(element: React.RefObject<HTMLElement | null>): boolean {
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry?.isIntersecting ?? false));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return isVisible;
}

function useAgentWhile(adapter: ReturnType<typeof createMemoryAdapter>, isOn: boolean): void {
  useEffect(() => {
    if (!isOn) return;
    const controller = new AbortController();
    simulateAgent(adapter, {
      signal: controller.signal,
      intervalMs: AGENT_INTERVAL_MS,
      script: AGENT_SCRIPT,
    });
    markAgentRunning(true);
    return () => {
      controller.abort();
      markAgentRunning(false);
    };
  }, [adapter, isOn]);
}

function AgentStatus(props: { isPaused: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-2 text-[0.8rem] text-fd-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${props.isPaused ? 'bg-fd-muted-foreground' : 'wk-pulse bg-amber'}`}
        />
        {props.isPaused ? 'Agent paused' : 'Agent at work'}
      </span>
      <button
        type="button"
        onClick={props.onToggle}
        className="rounded-md border border-fd-border px-2.5 py-1 text-[0.8rem] text-fd-foreground hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-fd-ring"
      >
        {props.isPaused ? 'Resume the agent' : 'Pause the agent'}
      </button>
    </div>
  );
}

/**
 * A `Workspace` over the sample files in memory. A simulated agent edits them, but only while the demo is
 * on screen: it stops when the demo scrolls out of view or unmounts. With `activity`, it sits in a window
 * frame with a pause button and a log of what the agent changed.
 *
 * @example
 * ```tsx
 * <LiveWorkspace />
 * ```
 */
export function LiveWorkspace(props: { activity?: boolean }): React.JSX.Element {
  const [adapter] = useState(createDemoAdapter);
  const [isPaused, setIsPaused] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const isVisible = useIsVisible(container);
  const theme = useSiteTheme();
  const controller = useRef<WorkspaceController>(null);
  useAgentWhile(adapter, isVisible && !isPaused);
  useEffect(() => {
    if (props.activity) controller.current?.open('README.md', 'pin');
  }, [props.activity]);
  const workspace = (
    <Workspace
      adapter={adapter}
      ref={controller}
      theme={theme ?? 'system'}
      style={{ height: props.activity ? 440 : 520 }}
      defaultFollow={props.activity === true}
    />
  );
  if (!props.activity) {
    return (
      <div ref={container} data-testid="live-workspace">
        {workspace}
      </div>
    );
  }
  return (
    <div
      ref={container}
      data-testid="live-workspace"
      className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-[0_24px_60px_-28px_rgb(20_27_45/0.35)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fd-border px-4 py-2.5">
        <span className="font-mono text-[0.8rem] text-fd-muted-foreground">your-app / files</span>
        <AgentStatus isPaused={isPaused} onToggle={() => setIsPaused((paused) => !paused)} />
      </div>
      {workspace}
      <AgentActivity adapter={adapter} />
    </div>
  );
}
