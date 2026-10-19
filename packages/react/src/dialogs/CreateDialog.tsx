'use client';
import { validateName, type EntryKind, type NameProblem } from '@scope/core';
import { useEffect, useId, useState, type ComponentType } from 'react';
import type { DialogSlotProps } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { useFileSystem, useTreeSnapshot } from '../provider/hooks';

/**
 * What the user reads for each `NameProblem`, including what to do about it.
 *
 * @example
 * ```ts
 * nameProblemMessage('duplicate', 'a.txt', 'file');
 * // '"a.txt" already exists in this folder. Choose another name.'
 * ```
 */
export function nameProblemMessage(problem: NameProblem, name: string, kind: EntryKind): string {
  switch (problem) {
    case 'empty':
      return `Enter a name for the ${kind === 'file' ? 'file' : 'folder'}.`;
    case 'invalid_chars':
      return 'Names cannot contain slashes, control characters or invisible characters. Remove them.';
    case 'reserved':
      return `"${name}" is reserved by the system, or ends with a dot or a space. Choose another name.`;
    case 'too_long':
      return 'This name is longer than 255 bytes. Choose a shorter name.';
    case 'duplicate':
      return `"${name}" already exists in this folder. Choose another name.`;
  }
}

/**
 * Props of `CreateDialog`.
 *
 * @example
 * ```tsx
 * const props: CreateDialogProps = {
 *   kind: 'file',
 *   parent: 'src',
 *   Dialog: DefaultDialog,
 *   onCreate,
 *   onCancel,
 * };
 * ```
 */
export interface CreateDialogProps {
  kind: EntryKind;
  parent: string;
  Dialog: ComponentType<DialogSlotProps>;
  classNames?: ClassNames;
  /** Called with a name that passed `validateName` against the folder's current entries. */
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/**
 * Asks for the name of a new file or folder in `parent`, validating it as you type with `validateName`.
 *
 * @example
 * ```tsx
 * <CreateDialog kind="directory" parent="src" Dialog={DefaultDialog} onCreate={create} onCancel={close} />
 * ```
 */
export function CreateDialog(props: CreateDialogProps): React.JSX.Element {
  const { kind, parent, Dialog, classNames, onCreate, onCancel } = props;
  const fs = useFileSystem();
  const { tree } = useTreeSnapshot();
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const inputId = useId();
  const messageId = useId();
  useEffect(() => {
    void fs.store.loadFolder(parent);
  }, [fs.store, parent]);

  const siblings = new Set(tree.folders.get(parent)?.children.keys() ?? []);
  const problem = validateName(name, siblings);
  const message = edited && problem ? nameProblemMessage(problem, name, kind) : null;
  return (
    <Dialog title={kind === 'file' ? 'New file' : 'New folder'} classNames={classNames} onClose={onCancel}>
      <form
        {...partProps('dialog-form', classNames)}
        onSubmit={(event) => {
          event.preventDefault();
          setEdited(true);
          if (!problem) onCreate(name);
        }}
      >
        <label {...partProps('dialog-label', classNames)} htmlFor={inputId}>
          Name
        </label>
        <input
          {...partProps('dialog-input', classNames)}
          id={inputId}
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setEdited(true);
          }}
        />
        <p {...partProps('dialog-message', classNames)} id={messageId} aria-live="polite">
          {message}
        </p>
        <div {...partProps('dialog-actions', classNames)}>
          <button type="button" {...partProps('dialog-button', classNames)} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" {...partProps('dialog-button', classNames)}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
