'use client';
import type { Entry } from '@workspacekit/core';
import { useState, type ComponentType } from 'react';
import type { DialogSlotProps } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import type { ConflictAnswer, ConflictKind } from './conflicts';

/**
 * Props of `ConflictDialog`.
 *
 * @example
 * ```tsx
 * const props: ConflictDialogProps = {
 *   kind: 'copy', path: 'docs/a.txt', remaining: 0, offersReplace: true, Dialog: DefaultDialog, onAnswer,
 * };
 * ```
 */
export interface ConflictDialogProps {
  kind: ConflictKind;
  /** The existing entry the transfer or upload would replace. */
  path: string;
  /** Above 0, an "Apply to all" checkbox is offered. */
  remaining: number;
  /**
   * The entry at `path`, when known; a folder makes the description warn that Replace deletes its contents.
   */
  existing?: Entry;
  offersReplace: boolean;
  Dialog: ComponentType<DialogSlotProps>;
  classNames?: ClassNames;
  /** `null` when the user cancels (Cancel, Escape or an outside click). */
  onAnswer: (answer: ConflictAnswer | null) => void;
}

const REPLACES_A_FILE: Record<ConflictKind, string> = {
  move: 'Replace overwrites it with the one you are moving.',
  copy: 'Replace overwrites it with the copy.',
  upload: 'Replace overwrites it with the uploaded file.',
};

const KEEPS_BOTH: Record<ConflictKind, string> = {
  move: 'Keep both moves yours under a new name.',
  copy: 'Keep both gives the copy a new name.',
  upload: 'Keep both uploads yours under a new name; Skip leaves this file out.',
};

function descriptionOf(props: ConflictDialogProps): string {
  const { kind, existing, offersReplace } = props;
  if (!offersReplace) return `It can't be replaced by this one. ${KEEPS_BOTH[kind]}`;
  if (existing?.kind === 'directory') {
    return `Replace deletes the existing folder "${existing.name}" and everything in it. ${KEEPS_BOTH[kind]}`;
  }
  return `${REPLACES_A_FILE[kind]} ${KEEPS_BOTH[kind]}`;
}

/**
 * Asks what to do when `path` already exists, as an `alertdialog` in the `Dialog` slot: Keep both (focused
 * first, the safe choice), Replace when it can work, and Cancel, or Skip for an upload. Replace is offered
 * only when `offersReplace`, and the description says plainly when it would delete a folder and everything in
 * it.
 *
 * @example
 * ```tsx
 * <ConflictDialog
 *   kind="move"
 *   path="docs/a.txt"
 *   remaining={0}
 *   offersReplace
 *   Dialog={DefaultDialog}
 *   onAnswer={settle}
 * />
 * ```
 */
export function ConflictDialog(props: ConflictDialogProps): React.JSX.Element {
  const { kind, path, remaining, offersReplace, Dialog, classNames, onAnswer } = props;
  const [applyToAll, setApplyToAll] = useState(false);
  const cancel = (): void => onAnswer(null);
  return (
    <Dialog
      role="alertdialog"
      title={`"${path}" already exists`}
      description={descriptionOf(props)}
      classNames={classNames}
      onClose={cancel}
    >
      {remaining > 0 && (
        <label {...partProps('dialog-label', classNames)}>
          <input
            type="checkbox"
            {...partProps('dialog-checkbox', classNames)}
            checked={applyToAll}
            onChange={(event) => setApplyToAll(event.currentTarget.checked)}
          />
          Apply to all remaining conflicts
        </label>
      )}
      <div {...partProps('dialog-actions', classNames)}>
        <button
          type="button"
          {...partProps('dialog-button', classNames)}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the safe choice takes focus ahead of the Apply to all checkbox
          autoFocus
          onClick={() => onAnswer({ choice: 'keepBoth', applyToAll })}
        >
          Keep both
        </button>
        {offersReplace && (
          <button
            type="button"
            {...partProps('dialog-button-danger', classNames)}
            onClick={() => onAnswer({ choice: 'replace', applyToAll })}
          >
            Replace
          </button>
        )}
        {kind === 'upload' ? (
          <button
            type="button"
            {...partProps('dialog-button', classNames)}
            onClick={() => onAnswer({ choice: 'skip', applyToAll })}
          >
            Skip
          </button>
        ) : (
          <button type="button" {...partProps('dialog-button', classNames)} onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
    </Dialog>
  );
}
