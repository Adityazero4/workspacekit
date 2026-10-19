'use client';
import { joinPath, parentPath, splitName, validateName, type Entry, type FolderNode } from '@scope/core';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { followMove } from '../actions/followMove';
import { notifyActionFailed } from '../actions/useTreeActions';
import { partProps } from '../cx';
import { nameProblemMessage } from '../dialogs/CreateDialog';
import type { ClassNames } from '../parts';
import { useFileSystem, type FileSystemContext } from '../provider/hooks';
import type { InlineRename, RenameSession } from './inlineRename';
import { focusIsInsideOrNowhere } from './rovingFocus';

/**
 * Props of `RenameInput`.
 *
 * @example
 * ```tsx
 * const props: RenameInputProps = { entry, session, inlineRename };
 * ```
 */
export interface RenameInputProps {
  entry: Entry;
  session: RenameSession;
  inlineRename: InlineRename;
  classNames?: ClassNames;
}

/**
 * The inline rename field that replaces a row's label. It focuses itself with the file's stem selected (a
 * folder or dotfile selects the whole name) and validates against the entry's siblings as you type. Enter
 * renames and focuses the renamed row, Esc cancels and returns focus to the row, and leaving the field
 * renames when the name is valid and cancels otherwise; switching to another window keeps it open. Keys and
 * clicks stay inside the field. A failed rename becomes an error notice and reopens the field with the typed
 * name, focused only after Enter and only if focus has not moved out of the tree.
 *
 * @example
 * ```tsx
 * {session ? (
 *   <RenameInput entry={entry} session={session} inlineRename={inlineRename} />
 * ) : (
 *   <span>{entry.name}</span>
 * )}
 * ```
 */
export function RenameInput(props: RenameInputProps): React.JSX.Element {
  const { entry, session, inlineRename, classNames } = props;
  const fs = useFileSystem();
  const parent = useFolderNode(fs, parentPath(entry.path));
  const [name, setName] = useState(session.draft ?? entry.name);
  const [initialSelection] = useState(
    () => session.selection ?? { start: 0, end: preselectionLength(entry, session.draft ?? entry.name) },
  );
  const input = useRef<HTMLInputElement>(null);
  const hasSetTheInitialSelection = useRef(false);
  const messageElement = useRef<HTMLSpanElement>(null);
  const messageId = useId();
  useLayoutEffect(() => {
    if (!session.takesFocus) return;
    input.current?.focus();
    if (hasSetTheInitialSelection.current) return;
    hasSetTheInitialSelection.current = true;
    input.current?.setSelectionRange(initialSelection.start, initialSelection.end);
  }, [session, initialSelection]);
  useLayoutEffect(() => inlineRename.attachInput(input.current!), [inlineRename]);

  const problem = validateName(name, siblingNamesOf(parent, entry));
  const message = problem ? nameProblemMessage(problem, name, entry.kind) : null;
  useLayoutEffect(() => {
    if (message) scrollTheTreeToShow(messageElement.current);
  }, [message]);

  const commit = (focusRenamedRow: boolean): void => {
    inlineRename.end(focusRenamedRow ? renamedPath(entry, name) : null);
    renameReopeningOnFailure(fs, inlineRename, {
      entry,
      name,
      wasCommittedWithEnter: focusRenamedRow,
      tree: input.current?.closest('[role=tree]') ?? null,
    });
  };
  const cancel = (focusRow: boolean): void => inlineRename.end(focusRow ? entry.path : null);

  return (
    <>
      <input
        ref={input}
        {...partProps('tree-rename-input', classNames)}
        value={name}
        aria-label={`Rename ${entry.name}`}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!problem) commit(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel(true);
          }
        }}
        onBlur={() => {
          const leftTheWindow = !document.hasFocus();
          if (leftTheWindow || inlineRename.session.get() !== session) return;
          if (problem) cancel(false);
          else commit(false);
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      />
      <span
        ref={messageElement}
        {...partProps('tree-rename-error', classNames)}
        id={messageId}
        aria-live="polite"
      >
        {message}
      </span>
    </>
  );
}

function useFolderNode(fs: FileSystemContext, path: string): FolderNode | undefined {
  const { store } = fs;
  const read = (): FolderNode | undefined => store.getSnapshot().tree.folders.get(path);
  return useSyncExternalStore(store.subscribe, read, read);
}

function scrollTheTreeToShow(element: HTMLElement | null): void {
  const viewport = element?.closest<HTMLElement>('[data-fs-part=tree-viewport]');
  if (!element || !viewport) return;
  const viewportBottom = viewport.getBoundingClientRect().top + viewport.clientTop + viewport.clientHeight;
  const hiddenBelow = element.getBoundingClientRect().bottom - viewportBottom;
  if (hiddenBelow > 0) viewport.scrollTop += hiddenBelow;
}

const preselectionLength = (entry: Entry, name: string): number =>
  entry.kind === 'file' ? splitName(name).stem.length : name.length;

const renamedPath = (entry: Entry, name: string): string => joinPath(parentPath(entry.path), name);

function siblingNamesOf(parent: FolderNode | undefined, entry: Entry): Set<string> {
  const names = parent?.children.keys() ?? [];
  return new Set([...names].filter((name) => name !== entry.name));
}

interface RenameAttempt {
  entry: Entry;
  name: string;
  wasCommittedWithEnter: boolean;
  tree: Element | null;
}

function renameReopeningOnFailure(
  fs: FileSystemContext,
  inlineRename: InlineRename,
  attempt: RenameAttempt,
): void {
  const { entry, name } = attempt;
  const newPath = renamedPath(entry, name);
  followMove(fs, entry.path, newPath, () => fs.store.rename(entry.path, name)).catch((error: unknown) => {
    notifyActionFailed(fs, 'Rename', entry, error);
    inlineRename.cancelFocus(newPath);
    if (inlineRename.session.get() !== null) return;
    const takesFocus = attempt.wasCommittedWithEnter && focusIsInsideOrNowhere(attempt.tree);
    inlineRename.start(entry.path, { draft: name, takesFocus });
  });
}
