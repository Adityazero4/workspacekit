'use client';
import type { ReactNode } from 'react';
import { partProps } from '../cx';
import type { Part } from '../parts';
import type { ViewerError } from '../viewer/errors';
import { StaleNotice } from './StaleNotice';
import { themeAttribute, type StandaloneViewerProps } from './standalone';

/**
 * Props of `StandaloneRoot`. `state` is the standalone file's load state; `isLoadingNewSource` marks the
 * root busy while a new `src` replaces the one shown; `staleError` is set while the content shown is a
 * previous version because the latest one failed to load. `P` is the renderer's part union, taken from
 * `viewer.classNames` (or given explicitly), so `part` and `errorPart` must be among its parts.
 *
 * @example
 * ```tsx
 * const rootProps: StandaloneRootProps<PdfPart> = {
 *   part: 'pdf-viewer',
 *   errorPart: 'pdf-error',
 *   state: file,
 *   viewer: props,
 * };
 * ```
 */
export interface StandaloneRootProps<P extends string = Part> {
  part: NoInfer<P>;
  errorPart: NoInfer<P>;
  state: { status: 'loading' | 'ready' } | { status: 'error'; error: ViewerError };
  viewer: Pick<StandaloneViewerProps<P>, 'className' | 'classNames' | 'style' | 'theme'>;
  isLoadingNewSource?: boolean;
  staleError?: ViewerError;
  children?: ReactNode;
}

/**
 * The root every standalone renderer shares: the `part` element with the viewer's `className`, `style` and
 * `data-theme`, `data-status="loading|error"`, `aria-busy` while loading, and the error message as a
 * `role="alert"` paragraph (the `errorPart`). With `staleError`, a `StaleNotice` above the content says the
 * latest version couldn't be opened and that the content is the previous version.
 *
 * @example
 * ```tsx
 * <StandaloneRoot part="media-viewer" errorPart="media-error" state={media} viewer={props}>
 *   {media.status === 'ready' && <audio src={media.url} controls />}
 * </StandaloneRoot>
 * ```
 */
export function StandaloneRoot<P extends string = Part>(props: StandaloneRootProps<P>): React.JSX.Element {
  const { part, errorPart, state, viewer, isLoadingNewSource, staleError, children } = props;
  const { className, classNames, style, theme } = viewer;
  return (
    <div
      {...partProps<P>(part, classNames, className)}
      style={style}
      data-theme={themeAttribute(theme)}
      data-status={state.status === 'ready' ? undefined : state.status}
      aria-busy={state.status === 'loading' || isLoadingNewSource === true || undefined}
    >
      {staleError && state.status !== 'error' && (
        <StaleNotice<P> error={staleError} classNames={classNames} />
      )}
      {state.status === 'error' && (
        <p {...partProps<P>(errorPart, classNames)} role="alert">
          {state.error.message}
        </p>
      )}
      {children}
    </div>
  );
}
