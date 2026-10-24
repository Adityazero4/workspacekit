'use client';
import { partProps } from '../cx';
import type { ClassNames, Part } from '../parts';
import type { ViewerError } from '../viewer/errors';

const STALE_NOTICE = "The latest version of this file couldn't be opened, so this is the previous version.";
const SHARED_STALE_NOTICE_PART = 'viewer-stale-notice';

/**
 * Props of `StaleNotice`: `error` is why the latest version failed to load. `part` defaults to the shared
 * `viewer-stale-notice` part, which `@workspacekit/react/styles.css` styles; a renderer package may pass one
 * of its own parts instead, with its part union as `P`.
 *
 * @example
 * ```tsx
 * const props: StaleNoticeProps<'pdf-stale-notice'> = {
 *   error: viewerError('load_error'),
 *   part: 'pdf-stale-notice',
 *   classNames: { 'pdf-stale-notice': 'my-notice' },
 * };
 * ```
 */
export interface StaleNoticeProps<P extends string = Part> {
  error: ViewerError;
  part?: NoInfer<P>;
  classNames?: ClassNames<P>;
}

/**
 * A `role="alert"` notice saying the latest version of the file couldn't be opened and the content below is
 * the previous version, followed by the error's message. Show it above content kept from an earlier
 * version, so stale content is never taken for the new file. `StandaloneRoot` renders it for its
 * `staleError`.
 *
 * @example
 * ```tsx
 * {latestError && shown && <StaleNotice error={latestError} />}
 * ```
 */
export function StaleNotice<P extends string = Part>(props: StaleNoticeProps<P>): React.JSX.Element {
  const { error, part, classNames } = props;
  return (
    <p {...partProps<string>(part ?? SHARED_STALE_NOTICE_PART, classNames)} role="alert">
      {`${STALE_NOTICE} ${error.message}`}
    </p>
  );
}
