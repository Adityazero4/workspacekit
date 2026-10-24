'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import type { RendererProps, ViewerError } from '@workspacekit/react/renderer-kit';
import { TextViewer } from '@workspacekit/react/renderers';
import { useEffect, useEffectEvent, useId, useState } from 'react';

import type { SheetData } from './reader/types';
import { SheetTabs } from './SheetTabs';
import { SheetView } from './SheetView';
import type { SpreadsheetRendererOptions } from './spreadsheetRenderer';
import {
  formatOf,
  isDelimitedText,
  lazyWorkerReader,
  openWorkbook,
  sheetToShow,
  viewerErrorOf,
  type WorkbookSource,
} from './workbookSource';

/**
 * Props of `SpreadsheetDocument`: the file's bytes and name, the view mode, the renderer options, and
 * `onError` for a file that cannot be read.
 *
 * @example
 * ```tsx
 * const props: SpreadsheetDocumentProps = { data, name: 'q3.xlsx', mode: 'table', onError: report };
 * ```
 */
export interface SpreadsheetDocumentProps extends SpreadsheetRendererOptions {
  data: ArrayBuffer;
  name: string;
  mode: string | undefined;
  onError: (error: ViewerError) => void;
}

interface Shown {
  source: WorkbookSource;
  index: number;
  sheet: SheetData;
}

function useShownSheet(props: SpreadsheetDocumentProps) {
  const [opened, setOpened] = useState<WorkbookSource>();
  const [requested, setRequested] = useState<number>();
  const [shown, setShown] = useState<Shown>();
  const workerFactory = useEffectEvent(() => props.workerFactory);
  const report = useEffectEvent((thrown: unknown) => {
    const error = viewerErrorOf(thrown);
    if (error) props.onError(error);
  });
  const engines = useEffectEvent(() => props.engines);
  const nameOf = useEffectEvent(() => props.name);
  useEffect(() => {
    const reader = lazyWorkerReader(workerFactory());
    let isCurrent = true;
    openWorkbook(props.data, formatOf(nameOf(), props.data), engines(), reader.get).then(
      (source) => isCurrent && setOpened(source),
      (thrown: unknown) => isCurrent && report(thrown),
    );
    return () => {
      isCurrent = false;
      reader.dispose();
    };
  }, [props.data]);
  useEffect(() => {
    if (!opened) return;
    let isCurrent = true;
    const index = sheetToShow(opened.info, requested);
    opened.sheet(index).then(
      (sheet) => isCurrent && setShown({ source: opened, index, sheet }),
      (thrown: unknown) => isCurrent && report(thrown),
    );
    return () => {
      isCurrent = false;
    };
  }, [opened, requested]);
  return { shown, select: setRequested };
}

/**
 * One spreadsheet: the selected sheet's grid with search and the selection readout, and the sheet tabs when
 * the workbook has more than one visible sheet (with a notice when it listed more than the first 1,024). A
 * newer version of the file replaces the sheet in place, keeping the selected sheet, the scroll position and
 * the selected cell. In `raw` mode CSV and TSV show as plain text.
 *
 * @example
 * ```tsx
 * <SpreadsheetDocument data={buffer} name="q3.xlsx" mode="table" onError={report} />
 * ```
 */
export default function SpreadsheetDocument(props: SpreadsheetDocumentProps): React.JSX.Element {
  const { classNames, name } = props;
  const { shown, select } = useShownSheet(props);
  const panelId = useId();
  const tabIdPrefix = useId();
  const format = formatOf(name, props.data);
  if (props.mode === 'raw' && isDelimitedText(format)) return <TextViewer src={props.data} fileName={name} />;
  if (!shown) {
    return (
      <p role="status" {...partProps('sheet-loading', classNames)}>
        Opening {name}…
      </p>
    );
  }
  const visibleSheets = shown.source.info.sheets
    .map((sheet, index) => ({ name: sheet.name, index, isHidden: sheet.isHidden }))
    .filter((sheet) => !sheet.isHidden);
  const hasTabs = visibleSheets.length > 1;
  const notice =
    props.mode === 'raw'
      ? 'Raw view is for CSV and TSV files.'
      : shown.source.info.hasMoreSheets && 'Showing the first 1,024 sheets.';
  return (
    <>
      {notice && (
        <p role="note" {...partProps('sheet-notice', classNames)}>
          {notice}
        </p>
      )}
      <div
        id={panelId}
        role={hasTabs ? 'tabpanel' : undefined}
        aria-labelledby={hasTabs ? `${tabIdPrefix}-${shown.index}` : undefined}
        {...partProps('sheet-panel', classNames)}
      >
        <SheetView
          key={shown.index}
          sheet={shown.sheet}
          find={(query) => shown.source.search(shown.index, query)}
          classNames={classNames}
        />
      </div>
      {hasTabs && (
        <SheetTabs
          sheets={visibleSheets}
          selected={shown.index}
          panelId={panelId}
          idPrefix={tabIdPrefix}
          onSelect={select}
          classNames={classNames}
        />
      )}
    </>
  );
}

/**
 * Props of `SpreadsheetRenderer`: the viewer's renderer props, with this package's parts in `classNames`,
 * and the renderer options.
 *
 * @example
 * ```tsx
 * const props: SpreadsheetRendererProps = { ...rendererProps, classNames: { 'sheet-cell': 'cell' } };
 * ```
 */
export interface SpreadsheetRendererProps
  extends Omit<RendererProps, 'classNames'>, SpreadsheetRendererOptions {}

/**
 * The registry's component for spreadsheets: the `sheet-viewer` root around `SpreadsheetDocument`.
 *
 * @example
 * ```tsx
 * <SpreadsheetRenderer {...rendererProps} engines={{ xlsx: () => import('xlsx') }} />
 * ```
 */
export function SpreadsheetRenderer(props: SpreadsheetRendererProps): React.JSX.Element {
  const { entry, source, classNames, className } = props;
  return (
    <div {...partProps('sheet-viewer', classNames, className)}>
      {source.kind === 'arrayBuffer' && (
        <SpreadsheetDocument
          data={source.data}
          name={entry.name}
          mode={props.mode}
          engines={props.engines}
          workerFactory={props.workerFactory}
          classNames={classNames}
          onError={props.onError}
        />
      )}
    </div>
  );
}
