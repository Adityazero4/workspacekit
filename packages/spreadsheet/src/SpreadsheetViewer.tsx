'use client';
import {
  partProps,
  StandaloneRoot,
  useStandaloneBytes,
  type StandaloneViewerProps,
  type ViewerError,
} from '@workspacekit/react/renderer-kit';
import { lazy, Suspense, useState } from 'react';
import type { SheetPart } from './parts';
import { SPREADSHEET_MAX_BYTES, type SpreadsheetRendererOptions } from './spreadsheetRenderer';

const SpreadsheetDocument = lazy(() => import('./SpreadsheetDocument'));

/**
 * Props of `SpreadsheetViewer`: the standalone viewer props, with this package's parts in `classNames`,
 * and the renderer options (`engines`, `workerFactory`).
 *
 * @example
 * ```tsx
 * const props: SpreadsheetViewerProps = { src: '/files/q3.xlsx', fileName: 'q3.xlsx' };
 * ```
 */
export interface SpreadsheetViewerProps
  extends StandaloneViewerProps<SheetPart>, Omit<SpreadsheetRendererOptions, 'classNames'> {}

/**
 * Shows a spreadsheet without a `FileSystemProvider`, read and drawn like the registry entry (see
 * `spreadsheetRenderer`). `src` is a URL (fetched) or the file's bytes or blob, up to 50 MiB; a larger file
 * is `too_large` and is not read. The format comes from `fileName` (sniffed when it has no extension). The
 * grid and the reader load on first render. A new `src` replaces the sheet in place, keeping the selected
 * sheet, scroll and cell; one that cannot be read shows its error, which also goes to `onError`.
 *
 * @example
 * ```tsx
 * <SpreadsheetViewer src={file} fileName={file.name} engines={{ xlsx: () => import('xlsx') }} />
 * ```
 */
export function SpreadsheetViewer(props: SpreadsheetViewerProps): React.JSX.Element {
  const { fileName, classNames, onError } = props;
  const { file, isLoadingNewSource } = useStandaloneBytes(props.src, onError, {
    maxBytes: SPREADSHEET_MAX_BYTES,
  });
  const [failure, setFailure] = useState<{ data: ArrayBuffer; error: ViewerError }>();
  const data = file.status === 'ready' ? file.data : undefined;
  const isFailed = failure !== undefined && failure.data === data;
  const name = fileName ?? 'Spreadsheet';
  return (
    <StandaloneRoot
      part="sheet-viewer"
      errorPart="sheet-error"
      state={isFailed ? { status: 'error', error: failure.error } : file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {data && !isFailed && (
        <Suspense
          fallback={
            <p role="status" {...partProps('sheet-loading', classNames)}>
              Opening {name}…
            </p>
          }
        >
          <SpreadsheetDocument
            data={data}
            name={name}
            mode="table"
            engines={props.engines}
            workerFactory={props.workerFactory}
            classNames={classNames}
            onError={(error) => {
              setFailure({ data, error });
              onError?.(error);
            }}
          />
        </Suspense>
      )}
    </StandaloneRoot>
  );
}
