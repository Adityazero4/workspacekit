'use client';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { sampleFiles, simulateAgent } from '@workspacekit/demo-kit';
import { Workspace } from '@workspacekit/workspace';
import '@workspacekit/workspace/styles.css';
import { useTheme } from 'fumadocs-ui/provider/base';
import { useEffect, useRef, useState } from 'react';
import { AGENT_INTERVAL_MS, AGENT_SCRIPT, countAgentWrites, markAgentRunning } from '../lib/agentProbe';

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

/**
 * A `Workspace` over the sample files in memory. A simulated agent edits them, but only while the demo is
 * on screen: it stops when the demo scrolls out of view or unmounts.
 *
 * @example
 * ```tsx
 * <LiveWorkspace />
 * ```
 */
export function LiveWorkspace(): React.JSX.Element {
  const [adapter] = useState(createDemoAdapter);
  const container = useRef<HTMLDivElement>(null);
  const isVisible = useIsVisible(container);
  const { resolvedTheme } = useTheme();
  useAgentWhile(adapter, isVisible);
  return (
    <div ref={container} data-testid="live-workspace">
      <Workspace
        adapter={adapter}
        theme={resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : 'system'}
        style={{ height: 520 }}
      />
    </div>
  );
}
