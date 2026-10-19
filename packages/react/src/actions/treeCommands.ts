'use client';
import type { Entry } from '@scope/core';
import { createContext, use, useEffect, useLayoutEffect, useState, type Context } from 'react';
import { createUiStore, type UiStore } from '../provider/ui-store';

/**
 * What a mounted tree lets the container around it run: its actions, as its menus run them, and Collapse all.
 * Identity-stable for the life of the tree; every call uses the tree's latest render.
 *
 * @example
 * ```ts
 * if (commands.canRun('newFile', selectedEntry)) commands.runAction('newFile', selectedEntry, newFileButton);
 * ```
 */
export interface TreeCommands {
  /**
   * Whether the tree's menu would show the action `actionId` for `entry` (adapter support, `when`,
   * `canPerform`).
   */
  canRun: (actionId: string, entry: Entry) => boolean;
  /**
   * Runs the action `actionId` on `entry` when `canRun` allows it. A dialog it opens returns focus to
   * `returnFocusTo` when it closes without creating an entry.
   */
  runAction: (actionId: string, entry: Entry, returnFocusTo: HTMLElement) => void;
  collapseAll: () => void;
}

/**
 * Where a container finds the commands of the trees mounted inside it. Like the provider's reveal and
 * conflict hosts, the first tree attached is the one that answers.
 *
 * @example
 * ```tsx
 * const [host] = useState(createTreeCommandsHost);
 * <TreeCommandsContext value={host}><FileTree /></TreeCommandsContext>
 * host.current.get()?.collapseAll();
 * ```
 */
export interface TreeCommandsHost {
  /**
   * The first attached tree's commands, or `null` with no tree. A new object each time the tree reports that
   * what `canRun` answers may have changed, so a component that reads it re-renders (and recomputes) then.
   */
  current: UiStore<TreeCommands | null>;
  /** Called by a tree while mounted; returns the detach. */
  attach: (commands: TreeCommands) => () => void;
  /** Called by an attached tree when what its `canRun` answers may have changed. */
  commandsChanged: (commands: TreeCommands) => void;
}

/**
 * A host with no tree attached yet.
 *
 * @example
 * ```ts
 * const host = createTreeCommandsHost();
 * ```
 */
export function createTreeCommandsHost(): TreeCommandsHost {
  const attached: TreeCommands[] = [];
  const current = createUiStore<TreeCommands | null>(null);
  const publishTheFirst = (): void => {
    const [first] = attached;
    current.set(first ? { ...first } : null);
  };
  return {
    current,
    attach: (commands) => {
      attached.push(commands);
      publishTheFirst();
      return () => {
        const at = attached.indexOf(commands);
        if (at >= 0) attached.splice(at, 1);
        publishTheFirst();
      };
    },
    commandsChanged: (commands) => {
      if (attached[0] === commands) publishTheFirst();
    },
  };
}

/**
 * Set by a container (the `Workspace`) whose toolbar runs the tree's commands.
 *
 * @example
 * ```tsx
 * <TreeCommandsContext value={host}>{children}</TreeCommandsContext>
 * ```
 */
export const TreeCommandsContext: Context<TreeCommandsHost | null> = createContext<TreeCommandsHost | null>(
  null,
);

function createCommandsCallingTheLatest(): {
  commands: TreeCommands;
  update: (latest: TreeCommands) => void;
} {
  let latest: TreeCommands = {
    canRun: () => false,
    runAction: () => undefined,
    collapseAll: () => undefined,
  };
  return {
    commands: {
      canRun: (actionId, entry) => latest.canRun(actionId, entry),
      runAction: (actionId, entry, returnFocusTo) => latest.runAction(actionId, entry, returnFocusTo),
      collapseAll: () => latest.collapseAll(),
    },
    update: (next) => {
      latest = next;
    },
  };
}

/**
 * What `canRun` answers depend on, compared by identity: a change is reported to the host once the latest
 * commands are in place.
 *
 * @example
 * ```ts
 * const inputs: CanRunInputs = { adapter: fs.adapter, actions: props.actions, canPerform: props.canPerform };
 * ```
 */
export interface CanRunInputs {
  adapter: unknown;
  actions: unknown;
  canPerform: unknown;
}

/**
 * Attaches the tree to the surrounding `TreeCommandsContext`, if any, while it is mounted, through
 * identity-stable commands that call the tree's latest ones. When one of `canRunInputs` changes, the host
 * publishes the commands anew once the latest ones are in place, so a toolbar that reads them shows what
 * `canRun` now answers.
 *
 * @example
 * ```ts
 * useAttachedTreeCommands(
 *   { canRun, runAction: treeActions.runFromOutside, collapseAll: tree.collapseAll },
 *   { adapter: fs.adapter, actions: props.actions, canPerform: props.canPerform },
 * );
 * ```
 */
export function useAttachedTreeCommands(latest: TreeCommands, canRunInputs: CanRunInputs): void {
  const host = use(TreeCommandsContext);
  const [callingTheLatest] = useState(createCommandsCallingTheLatest);
  const { commands, update } = callingTheLatest;
  const { adapter, actions, canPerform } = canRunInputs;
  useLayoutEffect(() => update(latest));
  useLayoutEffect(() => host?.commandsChanged(commands), [host, commands, adapter, actions, canPerform]);
  useEffect(() => host?.attach(commands), [host, commands]);
}
