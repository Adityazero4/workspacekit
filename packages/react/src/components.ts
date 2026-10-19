import type { ComponentType, ReactNode, SVGProps } from 'react';
import type { ClassNames } from './parts';

/**
 * Where a menu opens, in viewport pixels: the pointer for a right click, below the button or row otherwise.
 *
 * @example
 * ```ts
 * const anchor: MenuAnchor = { x: event.clientX, y: event.clientY };
 * ```
 */
export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * One item of an action menu, ready to render.
 *
 * @example
 * ```ts
 * const item: MenuSlotItem = { id: 'copy', label: 'Copy', shortcut: '⌘C', keyShortcuts: 'Meta+C' };
 * ```
 */
export interface MenuSlotItem {
  id: string;
  label: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** For display, already formatted for the platform (`⌘C`, `Ctrl+C`). */
  shortcut?: string;
  /** For `aria-keyshortcuts` (`Meta+C`, `Control+C`). */
  keyShortcuts?: string;
  /** Style with `--fs-danger`. */
  danger?: boolean;
}

/**
 * Props of the `Menu` slot. The menu is mounted while open; it calls `onSelect` for a chosen item or
 * `onClose` when dismissed, and must not move focus when it closes: the tree returns focus to the row. When
 * it closes because the user clicked or moved focus outside it, it calls `onInteractOutside` first, and the
 * tree leaves focus where the user put it.
 *
 * @example
 * ```tsx
 * function MyMenu({ groups, onSelect, onClose, onInteractOutside }: MenuSlotProps) {
 *   return (
 *     <Popover onClickOutside={() => { onInteractOutside?.(); onClose(); }}>
 *       {groups.flat().map((item) => (
 *         <button key={item.id} onClick={() => onSelect(item.id)}>
 *           {item.label}
 *         </button>
 *       ))}
 *       <button onClick={onClose}>Close</button>
 *     </Popover>
 *   );
 * }
 * ```
 */
export interface MenuSlotProps {
  anchor: MenuAnchor;
  /** The menu's accessible name, for example `Actions for a.txt`. */
  label: string;
  /** Items in groups; render a separator between groups. */
  groups: ReadonlyArray<readonly MenuSlotItem[]>;
  classNames?: ClassNames;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Call right before `onClose` when the menu closes because the user clicked or moved focus outside it. */
  onInteractOutside?: () => void;
}

/**
 * Props of the `Dialog` slot. The dialog is mounted while open; it calls `onClose` when dismissed (Escape,
 * outside click) and must not move focus when it closes: the tree returns focus to the row.
 *
 * @example
 * ```tsx
 * function MyDialog({ title, children }: DialogSlotProps) {
 *   return <section role="dialog" aria-label={title}>{children}</section>;
 * }
 * ```
 */
export interface DialogSlotProps {
  /** `alertdialog` for a confirmation that needs an answer; default `dialog`. */
  role?: 'dialog' | 'alertdialog';
  title: string;
  description?: string;
  /** The dialog's body: a form or the action buttons. */
  children: ReactNode;
  classNames?: ClassNames;
  onClose: () => void;
}

/**
 * Component slots (spec layer 5); defaults are Radix-based.
 *
 * The default menu and dialog render in place, inside the tree, so a `data-theme` on an ancestor applies to
 * them and they are positioned with `position: fixed`. The tree and its ancestors must therefore not set
 * `transform`, `filter`, `contain: paint | layout | strict` or `will-change: transform`, which would make
 * them position against that element instead of the screen. If you need one of those, pass a `Menu` and a
 * `Dialog` that render in a portal.
 *
 * With `classNames`, danger items use their own parts: set `menu-item-danger` next to `menu-item`, and
 * `dialog-button-danger` next to `dialog-button`.
 *
 * @example
 * ```tsx
 * <FileTree components={{ Menu: MyMenu, Dialog: MyDialog }} />
 * ```
 */
export interface Components {
  Menu?: ComponentType<MenuSlotProps>;
  Dialog?: ComponentType<DialogSlotProps>;
  /** Wraps `emptyState` inside the tree's empty-state container. */
  EmptyState?: ComponentType<{ children?: ReactNode }>;
}
