'use client';
import type { Components } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import type { ViewerError } from './registry';

/**
 * Props of `ViewerLoading`.
 *
 * @example
 * ```tsx
 * const props: ViewerLoadingProps = { fileName: 'a.txt', Loader: MySpinner };
 * ```
 */
export interface ViewerLoadingProps {
  fileName: string;
  Loader?: Components['Loader'];
  classNames?: ClassNames;
}

/**
 * The loading view: a `role="status"` named `Loading <file name>`, drawn by `Loader` when given.
 *
 * @example
 * ```tsx
 * <ViewerLoading fileName="a.txt" />
 * ```
 */
export function ViewerLoading(props: ViewerLoadingProps): React.JSX.Element {
  const { fileName, Loader, classNames } = props;
  const label = `Loading ${fileName}`;
  return (
    <div role="status" aria-label={label} {...partProps('viewer-loading', classNames)}>
      {Loader ? <Loader label={label} /> : `${label}…`}
    </div>
  );
}

/**
 * Props of `ViewerErrorView`.
 *
 * @example
 * ```tsx
 * const props: ViewerErrorViewProps = { error: viewerError('load_error'), onRetry: retry };
 * ```
 */
export interface ViewerErrorViewProps {
  error: ViewerError;
  /** Shown for `load_error` only. */
  onRetry?: () => void;
  /** Shown when set, except for `deleted`. */
  onDownload?: () => void;
  classNames?: ClassNames;
}

/**
 * Why the file cannot be shown, as a `role="alert"` with the error's message, Retry for `load_error`, and
 * Download when the file can be downloaded.
 *
 * @example
 * ```tsx
 * <ViewerErrorView error={viewerError('too_large')} onDownload={download} />
 * ```
 */
export function ViewerErrorView(props: ViewerErrorViewProps): React.JSX.Element {
  const { error, onRetry, onDownload, classNames } = props;
  const retry = error.kind === 'load_error' ? onRetry : undefined;
  const download = error.kind === 'deleted' ? undefined : onDownload;
  return (
    <div role="alert" {...partProps('viewer-error', classNames)}>
      <p {...partProps('viewer-message', classNames)}>{error.message}</p>
      {retry && (
        <button type="button" {...partProps('viewer-button', classNames)} onClick={retry}>
          Retry
        </button>
      )}
      {download && (
        <button type="button" {...partProps('viewer-button', classNames)} onClick={download}>
          Download
        </button>
      )}
    </div>
  );
}
