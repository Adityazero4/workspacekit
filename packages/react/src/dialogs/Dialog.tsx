'use client';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { DialogSlotProps } from '../components';
import { partProps } from '../cx';

const preventDefault = (event: Event): void => event.preventDefault();

/**
 * The default `Dialog` slot: a modal Radix dialog that traps focus, closes on Escape and outside clicks, and
 * focuses its first field or button when it opens. It renders in place (no portal), so a `data-theme` on an
 * ancestor of the tree applies to it.
 *
 * @example
 * ```tsx
 * <DefaultDialog title='Delete "a.txt"?' onClose={cancel}>
 *   <button onClick={confirm}>Delete</button>
 * </DefaultDialog>
 * ```
 */
export function DefaultDialog(props: DialogSlotProps): React.JSX.Element {
  const { role, title, description, classNames, children, onClose } = props;
  const withoutDescription = description ? {} : { 'aria-describedby': undefined };
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Overlay {...partProps('dialog-overlay', classNames)} />
      <RadixDialog.Content
        {...partProps('dialog', classNames)}
        role={role ?? 'dialog'}
        {...withoutDescription}
        onCloseAutoFocus={preventDefault}
      >
        <RadixDialog.Title {...partProps('dialog-title', classNames)}>{title}</RadixDialog.Title>
        {description && (
          <RadixDialog.Description {...partProps('dialog-description', classNames)}>
            {description}
          </RadixDialog.Description>
        )}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Root>
  );
}
