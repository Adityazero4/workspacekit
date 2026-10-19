import type { Entry, EntryKind } from '@scope/core';
import type { ComponentType, SVGProps } from 'react';
import type { FileSystemContext } from '../provider/hooks';
import type { FileTreeApi } from '../tree/useFileTree';
import type { UploadPickerKind } from '../uploads/useUploadInputs';

/**
 * What an action's `when` and `run` receive besides the entry.
 *
 * @example
 * ```ts
 * const rename: Action = {
 *   id: 'rename',
 *   label: 'Rename',
 *   run: (entry, context: ActionContext) => context.startRename(entry.path),
 * };
 * ```
 */
export interface ActionContext {
  entry: Entry;
  fs: FileSystemContext;
  tree: FileTreeApi;
  startRename(path: string): void;
  openCreate(kind: EntryKind, parent: string): void;
  /** Asks the user in a dialog; resolves `true` when they confirm, after focus is back on the row. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /**
   * Opens the file picker (`'files'`) or folder picker (`'folder'`) and uploads the selection into
   * `targetDir`.
   */
  pickUploads(kind: UploadPickerKind, targetDir: string): void;
}

/**
 * What `ActionContext.confirm` asks.
 *
 * @example
 * ```ts
 * const confirmed = await context.confirm({
 *   title: 'Delete "a.txt"?',
 *   confirmLabel: 'Delete',
 *   danger: true,
 * });
 * ```
 */
export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Styles the confirm button with `--fs-danger`. */
  danger?: boolean;
}

/**
 * One command on an entry, rendered in the context menu, the row's "More actions" button and as a keyboard
 * shortcut.
 *
 * @example
 * ```ts
 * const copyName: Action = {
 *   id: 'copyName',
 *   label: 'Copy name',
 *   run: (entry) => navigator.clipboard.writeText(entry.name),
 * };
 * ```
 */
export interface Action {
  id: string;
  label: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  group?: string;
  /**
   * For example `'Mod+C'` (Cmd on Apple platforms, Ctrl elsewhere), `'Mod+Shift+K'` or `'F2'`. Use Mod, Ctrl
   * or Meta, or a non-printable key: bare and Shift+letter keys go to the tree's type-ahead, and Alt+letter
   * composes characters on macOS. It works while a row has focus; auto-repeat is ignored.
   */
  shortcut?: string;
  when?(entry: Entry, context: ActionContext): boolean;
  danger?: boolean;
  run(entry: Entry, context: ActionContext): void | Promise<void>;
}

/**
 * Decides whether the user may run an action on an entry; a `false` hides the action everywhere.
 *
 * @example
 * ```ts
 * const canPerform: CanPerform = (actionId, entry) =>
 *   actionId !== 'delete' || !entry.path.startsWith('.git');
 * ```
 */
export type CanPerform = (actionId: string, entry: Entry) => boolean;

/**
 * The actions to show for `entry`: those whose `when` passes and that `canPerform` allows, in list order.
 *
 * @example
 * ```ts
 * const shown = actionsFor([...builtinActions(adapter), ...custom], entry, context, canPerform);
 * ```
 */
export function actionsFor(
  actions: readonly Action[],
  entry: Entry,
  context: ActionContext,
  canPerform?: CanPerform,
): Action[] {
  return actions.filter(
    (action) => (action.when?.(entry, context) ?? true) && (canPerform?.(action.id, entry) ?? true),
  );
}
