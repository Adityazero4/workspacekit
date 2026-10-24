'use client';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { basename, type Entry, type SortSpec } from '@workspacekit/core';
import { useState, type FC, type KeyboardEvent, type SVGProps } from 'react';
import { builtinActions } from '../actions/builtin';
import type { TreeCommandsHost } from '../actions/treeCommands';
import { partProps } from '../cx';
import { Icons } from '../icons';
import type { ClassNames } from '../parts';
import { useEntryState, useFileSystem, useUiValue, type FileSystemContext } from '../provider/hooks';
import { horizontalRovingIndex } from '../rovingIndex';

/**
 * Props of `Toolbar`.
 *
 * @example
 * ```tsx
 * const props: ToolbarProps = { treeCommands, follow: false, onFollowChange: setFollow };
 * ```
 */
export interface ToolbarProps {
  classNames?: ClassNames;
  /** The tree whose actions New file, New folder, Upload files and Collapse all run (the first attached). */
  treeCommands: TreeCommandsHost;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}

interface TreeActionButton {
  actionId: 'newFile' | 'newFolder' | 'uploadFiles';
  label: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
}

const TREE_ACTION_BUTTONS: readonly TreeActionButton[] = [
  { actionId: 'newFile', label: 'New file', Icon: Icons.NewFile },
  { actionId: 'newFolder', label: 'New folder', Icon: Icons.NewFolder },
  { actionId: 'uploadFiles', label: 'Upload files', Icon: Icons.Upload },
];

const SORT_FIELDS: ReadonlyArray<{ value: SortSpec['by']; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'extension', label: 'Extension' },
  { value: 'mtime', label: 'Modified' },
  { value: 'size', label: 'Size' },
];

const SORT_DIRECTIONS: ReadonlyArray<{ value: SortSpec['direction']; label: string }> = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
];

const TOOLBAR_BUTTON = '[data-fs-part=toolbar-button]';

function useSelectedEntryOrRoot(fs: FileSystemContext): Entry {
  const selected = useUiValue(fs.selected);
  const { entry } = useEntryState(selected ?? fs.root);
  return entry ?? { path: fs.root, name: basename(fs.root), kind: 'directory' };
}

function moveFocusAlongTheToolbar(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>(TOOLBAR_BUTTON)];
  const current = buttons.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  const target = horizontalRovingIndex(event.key, current, buttons.length);
  if (target === undefined) return;
  event.preventDefault();
  buttons[target]?.focus();
}

function SortRadioGroup<Value extends string>(props: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  classNames?: ClassNames;
  onChange: (value: Value) => void;
}): React.JSX.Element {
  const { label, value, options, classNames, onChange } = props;
  return (
    <RadixMenu.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(chosen) => {
        const option = options.find((candidate) => candidate.value === chosen);
        if (option) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <RadixMenu.RadioItem key={option.value} value={option.value} {...partProps('menu-item', classNames)}>
          <span {...partProps('menu-item-icon', classNames)} aria-hidden="true">
            <RadixMenu.ItemIndicator>
              <Icons.Dot />
            </RadixMenu.ItemIndicator>
          </span>
          <span {...partProps('menu-item-label', classNames)}>{option.label}</span>
        </RadixMenu.RadioItem>
      ))}
    </RadixMenu.RadioGroup>
  );
}

function toolbarButtonLabels(treeActionButtons: readonly TreeActionButton[], hasTree: boolean): string[] {
  return [
    ...treeActionButtons.map(({ label }) => label),
    ...(hasTree ? ['Collapse all folders'] : []),
    'Sort',
    'Show hidden files',
    'Follow agent changes',
  ];
}

type ToolbarButtonProps = ReturnType<typeof partProps> & {
  type: 'button';
  'aria-label': string;
  title: string;
  tabIndex: number;
  onFocus: () => void;
};

function useToolbarButtonsWithOneTabStop(
  labels: readonly string[],
  classNames: ClassNames | undefined,
): (label: string) => ToolbarButtonProps {
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  const tabStop = lastFocused !== null && labels.includes(lastFocused) ? lastFocused : labels[0];
  return (label) => ({
    type: 'button',
    'aria-label': label,
    title: label,
    tabIndex: label === tabStop ? 0 : -1,
    onFocus: () => setLastFocused(label),
    ...partProps('toolbar-button', classNames),
  });
}

function SortMenu(props: { triggerProps: ToolbarButtonProps; classNames?: ClassNames }): React.JSX.Element {
  const { triggerProps, classNames } = props;
  const fs = useFileSystem();
  const sort = useUiValue(fs.sort);
  return (
    <RadixMenu.Root modal={false}>
      <RadixMenu.Trigger asChild>
        <button {...triggerProps}>
          <Icons.Sort />
        </button>
      </RadixMenu.Trigger>
      <RadixMenu.Content {...partProps('menu', classNames)} aria-label="Sort" align="start" sideOffset={4}>
        <SortRadioGroup
          label="Sort by"
          value={sort.by}
          options={SORT_FIELDS}
          classNames={classNames}
          onChange={(by) => fs.sort.set((current) => ({ ...current, by }))}
        />
        <RadixMenu.Separator {...partProps('menu-separator', classNames)} />
        <SortRadioGroup
          label="Order"
          value={sort.direction}
          options={SORT_DIRECTIONS}
          classNames={classNames}
          onChange={(direction) => fs.sort.set((current) => ({ ...current, direction }))}
        />
      </RadixMenu.Content>
    </RadixMenu.Root>
  );
}

/**
 * The workspace toolbar: New file, New folder and Upload files (into the selected folder, or the selected
 * file's folder, else the root), Collapse all, a Sort menu, Show hidden and Follow. Each is an icon button
 * labelled with `aria-label` and a matching tooltip; Show hidden and Follow are toggle buttons
 * (`aria-pressed`). The tree actions run through the first attached tree, as its menus run them, and are left
 * out while no tree is mounted or when the adapter cannot perform them. One the tree's menu would not show
 * for the target (`when`, `canPerform`) stays in place with `aria-disabled`, so the buttons do not shift as
 * the selection moves, and follows a `canPerform` that changes. Following the WAI-ARIA toolbar pattern it is
 * one tab stop: Left and Right move between the buttons (wrapping), Home and End go to the ends. A dialog
 * opened from a button returns focus to it when cancelled.
 *
 * @example
 * ```tsx
 * <Toolbar treeCommands={treeCommands} follow={follow} onFollowChange={setFollow} />
 * ```
 */
export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const { classNames, treeCommands, follow, onFollowChange } = props;
  const fs = useFileSystem();
  const target = useSelectedEntryOrRoot(fs);
  const showHidden = useUiValue(fs.showHidden);
  const tree = useUiValue(treeCommands.current);
  const supported = new Set(builtinActions(fs.adapter).map((action) => action.id));
  const treeActionButtons = tree ? TREE_ACTION_BUTTONS.filter(({ actionId }) => supported.has(actionId)) : [];
  const buttonProps = useToolbarButtonsWithOneTabStop(
    toolbarButtonLabels(treeActionButtons, tree !== null),
    classNames,
  );

  return (
    <div
      role="toolbar"
      aria-label="File actions"
      {...partProps('toolbar', classNames)}
      onKeyDown={moveFocusAlongTheToolbar}
    >
      {tree &&
        treeActionButtons.map(({ actionId, label, Icon }) => {
          const allowed = tree.canRun(actionId, target);
          return (
            <button
              key={actionId}
              {...buttonProps(label)}
              aria-disabled={allowed ? undefined : true}
              onClick={(event) => {
                if (allowed) tree.runAction(actionId, target, event.currentTarget);
              }}
            >
              <Icon />
            </button>
          );
        })}
      {tree && (
        <button {...buttonProps('Collapse all folders')} onClick={() => tree.collapseAll()}>
          <Icons.CollapseAll />
        </button>
      )}
      <SortMenu triggerProps={buttonProps('Sort')} classNames={classNames} />
      <button
        {...buttonProps('Show hidden files')}
        aria-pressed={showHidden}
        onClick={() => fs.showHidden.set((shown) => !shown)}
      >
        <Icons.Eye />
      </button>
      <button
        {...buttonProps('Follow agent changes')}
        aria-pressed={follow}
        onClick={() => onFollowChange(!follow)}
      >
        <Icons.Follow />
      </button>
    </div>
  );
}
