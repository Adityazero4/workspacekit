'use client';
import type { ChangeEvent } from '@workspacekit/core';
import type { MemoryAdapter } from '@workspacekit/core/memory';
import { useEffect, useState } from 'react';

const KEPT_ENTRIES = 3;

const VERBS: Record<ChangeEvent['type'], string> = {
  created: 'created',
  updated: 'edited',
  deleted: 'deleted',
  moved: 'moved',
  resync: 'resynced',
};

interface ActivityEntry {
  id: number;
  verb: string;
  path: string;
}

function useAgentActivity(adapter: MemoryAdapter): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    let nextId = 0;
    return adapter.watch?.((events) => {
      const fresh = events
        .filter((event) => event.actor === 'agent' && event.type !== 'resync')
        .map((event) => ({ id: nextId++, verb: VERBS[event.type], path: event.path }));
      if (fresh.length > 0) setEntries((kept) => [...fresh.reverse(), ...kept].slice(0, KEPT_ENTRIES));
    });
  }, [adapter]);
  return entries;
}

/**
 * The agent's latest changes to `adapter`, newest first, as they happen: the same changes the workspace
 * above it highlights.
 *
 * @example
 * ```tsx
 * <AgentActivity adapter={adapter} />
 * ```
 */
export function AgentActivity(props: { adapter: MemoryAdapter }): React.JSX.Element {
  const entries = useAgentActivity(props.adapter);
  return (
    <section aria-label="What the agent changed" className="border-t border-fd-border px-4 py-3">
      <p className="mb-2 text-xs font-medium text-fd-muted-foreground">Agent activity</p>
      {entries.length === 0 ? (
        <p className="font-mono text-[0.8rem] text-fd-muted-foreground">
          Waiting for the agent's first change.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              className={`flex items-baseline gap-3 rounded px-1.5 font-mono text-[0.8rem] ${index === 0 ? 'wk-arrive' : 'opacity-70'}`}
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 translate-y-[-0.1rem] rounded-full bg-accent"
              />
              <span className="w-16 shrink-0 text-fd-muted-foreground">{entry.verb}</span>
              <span className="truncate text-fd-foreground">{entry.path}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
