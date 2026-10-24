'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import { useState } from 'react';
import { Grid } from './grid/Grid';
import type { CellAddress } from './grid/model';
import type { SheetClassNames } from './parts';
import { sheetGridModel } from './reader/gridModel';
import type { SheetData } from './reader/types';
import { SearchBar } from './SearchBar';

/**
 * Props of `SheetView`: the sheet, and `find`, which searches it (in the reader) and resolves to the
 * matching cells in the sheet's own indexes.
 *
 * @example
 * ```tsx
 * const props: SheetViewProps = { sheet, find: (query) => reader.search(0, query), classNames: undefined };
 * ```
 */
export interface SheetViewProps {
  sheet: SheetData;
  find: (query: string) => Promise<CellAddress[]>;
  classNames: SheetClassNames | undefined;
}

/**
 * One sheet: its search bar and selection readout, a "first N rows" notice when the sheet was cut at the
 * caps, and the grid; or "No data available" for an empty sheet. The selected cell lives here, so a newer
 * version of the same sheet keeps it (moved inside the sheet if the sheet shrank). The readout is not a
 * live region: the focused cell already announces itself, so moving through cells is not read twice.
 *
 * @example
 * ```tsx
 * <SheetView key={index} sheet={sheet} find={find} classNames={classNames} />
 * ```
 */
export function SheetView(props: SheetViewProps): React.JSX.Element {
  const { sheet, classNames } = props;
  const model = sheetGridModel(sheet);
  const [requested, setActive] = useState<CellAddress>({ row: 0, col: 0 });
  const active = {
    row: Math.max(0, Math.min(requested.row, model.rowCount - 1)),
    col: Math.max(0, Math.min(requested.col, model.colCount - 1)),
  };
  if (model.rowCount === 0) {
    return (
      <p role="status" {...partProps('sheet-empty', classNames)}>
        No data available
      </p>
    );
  }
  const find = async (query: string): Promise<CellAddress[]> =>
    (await props.find(query)).flatMap((cell) => model.displayCellOf(cell) ?? []);
  const selected = model.cell(active.row, active.col)?.text;
  return (
    <>
      <div {...partProps('sheet-toolbar', classNames)}>
        <SearchBar find={find} onMatch={setActive} classNames={classNames} />
        <span {...partProps('sheet-selection', classNames)}>
          {model.colLabel!(active.col)}
          {model.rowLabel!(active.row)}
          {selected ? `: ${selected}` : ''}
        </span>
      </div>
      {sheet.isTruncated && (
        <p role="note" {...partProps('sheet-notice', classNames)}>
          Showing the first {sheet.rowCount.toLocaleString('en-US')} rows.
        </p>
      )}
      <Grid
        model={model}
        aria-label={sheet.name}
        activeCell={active}
        onActiveCellChange={setActive}
        classNames={classNames}
      />
    </>
  );
}
