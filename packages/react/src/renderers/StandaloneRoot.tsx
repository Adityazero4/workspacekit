'use client';
import type { ReactNode } from 'react';
import { partProps } from '../cx';
import type { Part } from '../parts';
import type { ViewerError } from '../viewer/errors';
import { themeAttribute, type StandaloneViewerProps } from './standalone';

const STALE_NOTICE = "The latest version of this file couldn't be opened, so this is the previous version.";

/**
 * Props of `StandaloneRoot`. `state` is the standalone file's load state; `isLoadingNewSource` marks the
 * root busy while a new `src` replaces the one shown; `staleError` is set while the content shown is a
 * previous version because the latest one failed to load.
 *
 * @example
 * ```tsx
 * const props: StandaloneRootProps = {
 *   part: 'image-viewer',
 *   errorPart: 'image-error',
 *   state: media,
 *   viewer: props,
 * };
 * ```
 */
export interface StandaloneRootProps {
  part: Part;
  errorPart: Part;
  state: { status: 'loading' | 'ready' } | { status: 'error'; error: ViewerError };
  viewer: Pick<StandaloneViewerProps, 'className' | 'classNames' | 'style' | 'theme'>;
  isLoadingNewSource?: boolean;
  staleError?: ViewerError;
  children?: ReactNode;
}

/**
 * The root every standalone renderer shares: the `part` element with the viewer's `className`, `style` and
 * `data-theme`, `data-status="loading|error"`, `aria-busy` while loading, and the error message as a
 * `role="alert"` paragraph (the `errorPart`). With `staleError`, a `role="alert"` notice (the
 * `viewer-stale-notice` part) above the content says the latest version couldn't be opened and that the
 * content is the previous version, so stale content is never taken for the new file.
 *
 * @example
 * ```tsx
 * <StandaloneRoot part="media-viewer" errorPart="media-error" state={media} viewer={props}>
 *   {media.status === 'ready' && <audio src={media.url} controls />}
 * </StandaloneRoot>
 * ```
 */
export function StandaloneRoot(props: StandaloneRootProps): React.JSX.Element {
  const { part, errorPart, state, viewer, isLoadingNewSource, staleError, children } = props;
  const { className, classNames, style, theme } = viewer;
  return (
    <div
      {...partProps(part, classNames, className)}
      style={style}
      data-theme={themeAttribute(theme)}
      data-status={state.status === 'ready' ? undefined : state.status}
      aria-busy={state.status === 'loading' || isLoadingNewSource === true || undefined}
    >
      {staleError && state.status !== 'error' && (
        <p {...partProps('viewer-stale-notice', classNames)} role="alert">
          {`${STALE_NOTICE} ${staleError.message}`}
        </p>
      )}
      {state.status === 'error' && (
        <p {...partProps(errorPart, classNames)} role="alert">
          {state.error.message}
        </p>
      )}
      {children}
    </div>
  );
}
