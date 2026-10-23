'use client';
import {
  partProps,
  StandaloneRoot,
  useStandaloneBytes,
  type StandaloneViewerProps,
  type ViewerError,
} from '@scope/react/renderer-kit';
import { lazy, Suspense, useState } from 'react';
import type { PptxClassNames, PptxPart } from './parts';
import { PPTX_MAX_BYTES, type PptxRendererOptions } from './pptxRenderer';

const PptxDocument = lazy(() => import('./PptxDocument'));

/**
 * Props of `PptxViewer`: the standalone viewer props, with this package's parts in `classNames`, and the
 * renderer options.
 *
 * @example
 * ```tsx
 * const props: PptxViewerProps = { src: '/files/deck.pptx', fileName: 'deck.pptx', theme: 'dark' };
 * ```
 */
export interface PptxViewerProps extends StandaloneViewerProps<PptxPart>, PptxRendererOptions {}

/**
 * The status shown while the presentation code, then the presentation, loads.
 *
 * @example
 * ```tsx
 * <Suspense fallback={<PptxLoading name="deck.pptx" classNames={classNames} />} />
 * ```
 */
export function PptxLoading(props: {
  name: string;
  classNames: PptxClassNames | undefined;
}): React.JSX.Element {
  return (
    <p {...partProps('pptx-loading', props.classNames)} role="status">
      Opening {props.name}…
    </p>
  );
}

/**
 * Shows a PowerPoint `.pptx` without a `FileSystemProvider`, drawn and checked like the registry entry (see
 * `pptxRenderer`). `src` is a URL (fetched) or the file's bytes or blob, up to 200 MiB; a larger file is
 * `too_large` and is not read. The renderer loads on first render, so importing this is cheap. A new `src`
 * replaces the presentation once it has opened, keeping the slide and zoom; one that cannot be opened shows
 * its error, which also goes to `onError`.
 *
 * @example
 * ```tsx
 * <PptxViewer src={file} fileName={file.name} />
 * ```
 */
export function PptxViewer(props: PptxViewerProps): React.JSX.Element {
  const { fileName, classNames, onError, externalMedia } = props;
  const { file, isLoadingNewSource } = useStandaloneBytes(props.src, onError, { maxBytes: PPTX_MAX_BYTES });
  const [failure, setFailure] = useState<{ data: ArrayBuffer; error: ViewerError }>();
  const data = file.status === 'ready' ? file.data : undefined;
  const isFailed = failure !== undefined && failure.data === data;
  const name = fileName ?? 'PowerPoint presentation';
  return (
    <StandaloneRoot
      part="pptx-viewer"
      errorPart="pptx-error"
      state={isFailed ? { status: 'error', error: failure.error } : file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {data && !isFailed && (
        <Suspense fallback={<PptxLoading name={name} classNames={classNames} />}>
          <PptxDocument
            data={data}
            name={name}
            externalMedia={externalMedia}
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
