'use client';
import {
  partProps,
  StandaloneRoot,
  useStandaloneBytes,
  type StandaloneViewerProps,
  type ViewerError,
} from '@scope/react/renderer-kit';
import { lazy, Suspense, useState } from 'react';
import { DOCX_MAX_BYTES } from './docxRenderer';
import type { DocxClassNames, DocxPart } from './parts';

const DocxDocument = lazy(() => import('./DocxDocument'));

/**
 * Props of `DocxViewer`: the standalone viewer props, with this package's parts in `classNames`.
 *
 * @example
 * ```tsx
 * const props: DocxViewerProps = { src: '/files/report.docx', fileName: 'report.docx', theme: 'dark' };
 * ```
 */
export type DocxViewerProps = StandaloneViewerProps<DocxPart>;

/**
 * The status shown while the document code, then the document, loads.
 *
 * @example
 * ```tsx
 * <Suspense fallback={<DocxLoading name="report.docx" classNames={classNames} />} />
 * ```
 */
export function DocxLoading(props: {
  name: string;
  classNames: DocxClassNames | undefined;
}): React.JSX.Element {
  'use no memo';
  return (
    <p {...partProps('docx-loading', props.classNames)} role="status">
      Opening {props.name}…
    </p>
  );
}

/**
 * Shows a Word `.docx` without a `FileSystemProvider`, laid out in pages and sanitized like the registry
 * entry (see `docxRenderer`). `src` is a URL (fetched) or the file's bytes or blob, up to 25 MiB; a larger
 * file is `too_large` and is not read. docx-preview loads on first render, so importing this is cheap. A new
 * `src` replaces the document once it has rendered; one that cannot be opened shows its error, which also
 * goes to `onError`.
 *
 * @example
 * ```tsx
 * <DocxViewer src={file} fileName={file.name} />
 * ```
 */
export function DocxViewer(props: DocxViewerProps): React.JSX.Element {
  'use no memo';
  const { fileName, classNames, onError } = props;
  const { file, isLoadingNewSource } = useStandaloneBytes(props.src, onError, { maxBytes: DOCX_MAX_BYTES });
  const [failure, setFailure] = useState<{ data: ArrayBuffer; error: ViewerError }>();
  const data = file.status === 'ready' ? file.data : undefined;
  const isFailed = failure !== undefined && failure.data === data;
  const name = fileName ?? 'Word document';
  return (
    <StandaloneRoot
      part="docx-viewer"
      errorPart="docx-error"
      state={isFailed ? { status: 'error', error: failure.error } : file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {data && !isFailed && (
        <Suspense fallback={<DocxLoading name={name} classNames={classNames} />}>
          <DocxDocument
            data={data}
            name={name}
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
