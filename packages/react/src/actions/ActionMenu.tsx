'use client';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { Entry } from '@scope/core';
import { Fragment, useEffect, useRef, type ComponentType } from 'react';
import type { MenuAnchor, MenuSlotItem, MenuSlotProps } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { isMac } from '../tree/keyboard';
import type { Action } from './actions';
import { ariaKeyShortcuts, shortcutLabel } from './shortcuts';

function menuItemOf(action: Action, isMacPlatform: boolean): MenuSlotItem {
  const item: MenuSlotItem = { id: action.id, label: action.label };
  if (action.icon) item.icon = action.icon;
  if (action.danger) item.danger = true;
  if (action.shortcut) {
    item.shortcut = shortcutLabel(action.shortcut, isMacPlatform);
    item.keyShortcuts = ariaKeyShortcuts(action.shortcut, isMacPlatform);
  }
  return item;
}

function groupedMenuItems(actions: readonly Action[], isMacPlatform: boolean): MenuSlotItem[][] {
  const groups = new Map<string, MenuSlotItem[]>();
  for (const action of actions) {
    const group = action.group ?? '';
    const items = groups.get(group) ?? [];
    items.push(menuItemOf(action, isMacPlatform));
    groups.set(group, items);
  }
  return [...groups.values()];
}

const preventDefault = (event: Event): void => event.preventDefault();

/**
 * Props of `ActionMenu`.
 *
 * @example
 * ```tsx
 * const props: ActionMenuProps = {
 *   entry,
 *   actions,
 *   anchor,
 *   Menu: DefaultMenu,
 *   onSelect: run,
 *   onClose: close,
 * };
 * ```
 */
export interface ActionMenuProps {
  entry: Entry;
  /** Already filtered by `when` and `canPerform`. */
  actions: readonly Action[];
  anchor: MenuAnchor;
  Menu: ComponentType<MenuSlotProps>;
  classNames?: ClassNames;
  onSelect: (action: Action) => void;
  onClose: () => void;
  onInteractOutside?: () => void;
}

/**
 * The action menu of one entry, grouped by `Action.group` and rendered through the `Menu` slot. Renders
 * nothing when no action applies.
 *
 * @example
 * ```tsx
 * <ActionMenu
 *   entry={entry}
 *   actions={shown}
 *   anchor={anchor}
 *   Menu={DefaultMenu}
 *   onSelect={run}
 *   onClose={close}
 * />
 * ```
 */
export function ActionMenu(props: ActionMenuProps): React.JSX.Element | null {
  const { entry, actions, anchor, Menu, classNames, onSelect, onClose, onInteractOutside } = props;
  if (actions.length === 0) return null;
  return (
    <Menu
      anchor={anchor}
      label={`Actions for ${entry.name}`}
      groups={groupedMenuItems(actions, isMac())}
      classNames={classNames}
      onSelect={(id) => {
        const action = actions.find((candidate) => candidate.id === id);
        if (action) onSelect(action);
      }}
      onClose={onClose}
      onInteractOutside={onInteractOutside}
    />
  );
}

function DefaultMenuItem(props: {
  item: MenuSlotItem;
  classNames?: ClassNames;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { item, classNames, onSelect } = props;
  const Icon = item.icon;
  return (
    <RadixMenu.Item
      {...partProps(item.danger ? 'menu-item-danger' : 'menu-item', classNames)}
      aria-keyshortcuts={item.keyShortcuts}
      onSelect={(event) => {
        event.preventDefault();
        onSelect(item.id);
      }}
    >
      {Icon && (
        <span {...partProps('menu-item-icon', classNames)} aria-hidden="true">
          <Icon />
        </span>
      )}
      <span {...partProps('menu-item-label', classNames)}>{item.label}</span>
      {item.shortcut && (
        <span {...partProps('menu-shortcut', classNames)} aria-hidden="true">
          {item.shortcut}
        </span>
      )}
    </RadixMenu.Item>
  );
}

/**
 * The default `Menu` slot: a Radix dropdown menu opened at `anchor` with its first item focused, keyboard
 * navigation, type-ahead and Escape. It is not modal: like the WAI-ARIA menu pattern, it leaves the rest of
 * the page exposed to assistive technology instead of hiding it with `aria-hidden`, and a click or focus
 * outside it calls `onInteractOutside` before closing it, so focus stays where the user put it. It renders in
 * place (no portal), so a `data-theme` on an ancestor of the tree applies to it.
 *
 * @example
 * ```tsx
 * <DefaultMenu
 *   anchor={{ x: 10, y: 20 }}
 *   label="Actions for a.txt"
 *   groups={groups}
 *   onSelect={run}
 *   onClose={close}
 * />
 * ```
 */
export function DefaultMenu(props: MenuSlotProps): React.JSX.Element {
  const { anchor, label, groups, classNames, onSelect, onClose, onInteractOutside } = props;
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, []);
  return (
    <RadixMenu.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixMenu.Trigger asChild>
        <span
          {...partProps('menu-anchor', classNames)}
          aria-hidden="true"
          style={{ left: anchor.x, top: anchor.y }}
        />
      </RadixMenu.Trigger>
      <RadixMenu.Content
        ref={content}
        {...partProps('menu', classNames)}
        aria-label={label}
        align="start"
        onCloseAutoFocus={preventDefault}
        onInteractOutside={() => onInteractOutside?.()}
      >
        {groups.map((group, groupIndex) => (
          <Fragment key={group[0]?.id ?? groupIndex}>
            {groupIndex > 0 && <RadixMenu.Separator {...partProps('menu-separator', classNames)} />}
            {group.map((item) => (
              <DefaultMenuItem key={item.id} item={item} classNames={classNames} onSelect={onSelect} />
            ))}
          </Fragment>
        ))}
      </RadixMenu.Content>
    </RadixMenu.Root>
  );
}
