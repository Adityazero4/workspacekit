'use client';
import { partProps } from '@scope/react/renderer-kit';
import type { KeyboardEvent } from 'react';
import type { SheetClassNames } from './parts';

/**
 * Props of `SheetTabs`: the visible sheets (`index` is the workbook's own index), the selected one, and the
 * id of the panel the tabs control.
 *
 * @example
 * ```tsx
 * const props: SheetTabsProps = { sheets, selected: 0, panelId, onSelect, classNames: undefined };
 * ```
 */
export interface SheetTabsProps {
  sheets: readonly { name: string; index: number }[];
  selected: number;
  panelId: string;
  idPrefix: string;
  onSelect: (index: number) => void;
  classNames: SheetClassNames | undefined;
}

function neighbourTab(key: string, position: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (position + 1) % count;
    case 'ArrowLeft':
      return (position - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * The workbook's sheets as a WAI-ARIA `tablist`: one tab stop, the arrow keys, Home and End move between
 * tabs and select them, and each tab controls the sheet panel.
 *
 * @example
 * ```tsx
 * <SheetTabs
 *   sheets={[{ name: 'Data', index: 0 }]}
 *   selected={0}
 *   panelId="sheet-panel"
 *   idPrefix="sheet-tab"
 *   onSelect={select}
 *   classNames={undefined}
 * />
 * ```
 */
export function SheetTabs(props: SheetTabsProps): React.JSX.Element {
  const { sheets, selected, classNames } = props;
  const tabId = (index: number): string => `${props.idPrefix}-${index}`;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const position = sheets.findIndex((sheet) => sheet.index === selected);
    const next = neighbourTab(event.key, position, sheets.length);
    if (next === undefined) return;
    event.preventDefault();
    const sheet = sheets[next]!;
    props.onSelect(sheet.index);
    event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };
  return (
    <div role="tablist" aria-label="Sheets" {...partProps('sheet-tabs', classNames)}>
      {sheets.map((sheet) => {
        const isSelected = sheet.index === selected;
        return (
          <button
            key={sheet.index}
            id={tabId(sheet.index)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={props.panelId}
            tabIndex={isSelected ? 0 : -1}
            data-selected={isSelected || undefined}
            {...partProps('sheet-tab', classNames)}
            onClick={() => props.onSelect(sheet.index)}
            onKeyDown={onKeyDown}
          >
            {sheet.name}
          </button>
        );
      })}
    </div>
  );
}
