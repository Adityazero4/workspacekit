'use client';
import type { ComponentType } from 'react';
import type { ConfirmRequest } from '../actions/actions';
import type { DialogSlotProps } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';

/**
 * Props of `ConfirmDialog`.
 *
 * @example
 * ```tsx
 * const props: ConfirmDialogProps = {
 *   request,
 *   Dialog: DefaultDialog,
 *   onAnswer: (confirmed) => resolve(confirmed),
 * };
 * ```
 */
export interface ConfirmDialogProps {
  request: ConfirmRequest;
  Dialog: ComponentType<DialogSlotProps>;
  classNames?: ClassNames;
  onAnswer: (confirmed: boolean) => void;
}

/**
 * A yes/no question in the `Dialog` slot, as an `alertdialog`. Cancel comes first, so the default dialog
 * focuses the safe choice.
 *
 * @example
 * ```tsx
 * <ConfirmDialog
 *   request={{ title: 'Delete "a.txt"?', confirmLabel: 'Delete', danger: true }}
 *   Dialog={DefaultDialog}
 *   onAnswer={answer}
 * />
 * ```
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  const { request, Dialog, classNames, onAnswer } = props;
  return (
    <Dialog
      role="alertdialog"
      title={request.title}
      description={request.description}
      classNames={classNames}
      onClose={() => onAnswer(false)}
    >
      <div {...partProps('dialog-actions', classNames)}>
        <button type="button" {...partProps('dialog-button', classNames)} onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <button
          type="button"
          {...partProps(request.danger ? 'dialog-button-danger' : 'dialog-button', classNames)}
          onClick={() => onAnswer(true)}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
