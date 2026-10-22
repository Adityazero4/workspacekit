'use client';
import { useEffect, useLayoutEffect, useRef, type RefObject, type SyntheticEvent } from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import { viewerError, type ViewerError } from '../../viewer/errors';
import type { RendererProps } from '../../viewer/registry';
import { useStandaloneUrl, type StandaloneViewerProps } from '../standalone';
import { StandaloneRoot } from '../StandaloneRoot';

const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

interface Playback {
  time: number;
  paused: boolean;
}

/**
 * Props of `MediaPlayer`: an `<audio>` or `<video>` playing `url`.
 *
 * @example
 * ```tsx
 * const props: MediaPlayerProps = {
 *   kind: 'audio',
 *   url,
 *   withCredentials: false,
 *   isActive: true,
 *   label: 'a.mp3',
 *   onError,
 * };
 * ```
 */
export interface MediaPlayerProps {
  kind: 'audio' | 'video';
  url: string;
  withCredentials: boolean;
  isActive: boolean;
  label: string;
  onError: (error: ViewerError) => void;
  classNames?: ClassNames;
}

const ignoreRefusedPlayback = (): void => undefined;

function swapSourceKeepingPlayback(
  element: HTMLMediaElement,
  url: string,
  pendingPlayback: { current: Playback | undefined },
): (() => void) | undefined {
  const hadSource = element.currentSrc !== '';
  const playback =
    pendingPlayback.current ??
    (hadSource ? { time: element.currentTime, paused: element.paused } : undefined);
  element.src = url;
  if (!playback) return undefined;
  pendingPlayback.current = playback;
  const restore = (): void => {
    pendingPlayback.current = undefined;
    element.currentTime = playback.time;
    if (!playback.paused) element.play().catch(ignoreRefusedPlayback);
  };
  element.addEventListener('loadedmetadata', restore, { once: true });
  return () => element.removeEventListener('loadedmetadata', restore);
}

function useSourceKeepingPlayback(media: RefObject<HTMLMediaElement | null>, url: string): void {
  const pendingPlayback = useRef<Playback | undefined>(undefined);
  useLayoutEffect(() => {
    const element = media.current;
    if (!element || element.getAttribute('src') === url) return;
    return swapSourceKeepingPlayback(element, url, pendingPlayback);
  }, [media, url]);
}

const errorOf = (element: HTMLMediaElement): ViewerError => {
  const code = element.error?.code;
  const isUnplayable = code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED;
  return viewerError(isUnplayable ? 'unsupported_media' : 'load_error', element.error ?? undefined);
};

/**
 * A native `<audio>` or `<video>` (with `controls` and `preload="metadata"`) playing `url`. It pauses when
 * `isActive` turns false. A new `url` keeps the playback position and whether it was playing; a refused
 * `play()` leaves it paused. `MediaError` codes 3 and 4 are reported as `unsupported_media`, any other as
 * `load_error`. `withCredentials` sets `crossOrigin="use-credentials"`.
 *
 * @example
 * ```tsx
 * <MediaPlayer kind="video" url={url} withCredentials={false} isActive label="clip.mp4" onError={onError} />
 * ```
 */
export function MediaPlayer(props: MediaPlayerProps): React.JSX.Element {
  const { kind, url, withCredentials, isActive, label, onError, classNames } = props;
  const media = useRef<HTMLMediaElement | null>(null);
  useSourceKeepingPlayback(media, url);
  useEffect(() => {
    if (!isActive) media.current?.pause();
  }, [isActive]);
  const shared = {
    ref: (element: HTMLMediaElement | null) => {
      media.current = element;
    },
    controls: true,
    preload: 'metadata',
    crossOrigin: withCredentials ? ('use-credentials' as const) : undefined,
    'aria-label': label,
    onError: (event: SyntheticEvent<HTMLMediaElement>) => onError(errorOf(event.currentTarget)),
  };
  return kind === 'audio' ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- a user's file comes with no caption track to add; captions inside the media still show in the native player
    <audio {...partProps('media-audio', classNames)} {...shared} />
  ) : (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- a user's file comes with no caption track to add; captions inside the media still show in the native player
    <video {...partProps('media-video', classNames)} {...shared} />
  );
}

/**
 * A standalone `AudioViewer` or `VideoViewer`: `src` turned into a URL (bytes become an object URL, revoked
 * once the next one is in place, and on unmount), then a `MediaPlayer`. A failure shows as an alert and goes
 * to `onError`.
 *
 * @example
 * ```tsx
 * <StandaloneMedia kind="audio" src={file} fileName={file.name} />
 * ```
 */
export function StandaloneMedia(
  props: StandaloneViewerProps & { kind: MediaPlayerProps['kind'] },
): React.JSX.Element {
  const { kind, src, fileName, classNames, onError } = props;
  const { media, reportError } = useStandaloneUrl(src, fileName, onError);
  return (
    <StandaloneRoot part="media-viewer" errorPart="media-error" state={media} viewer={props}>
      {media.status === 'ready' && (
        <MediaPlayer
          kind={kind}
          url={media.url}
          withCredentials={false}
          isActive
          label={fileName ?? (kind === 'audio' ? 'Audio' : 'Video')}
          onError={reportError}
          classNames={classNames}
        />
      )}
    </StandaloneRoot>
  );
}

/**
 * The registry component behind the audio and video renderers: a `MediaPlayer` of `kind` for a viewer's
 * `url` source, paused while its tab is inactive.
 *
 * @example
 * ```tsx
 * export default (props: RendererProps) => <MediaRenderer {...props} kind="audio" />;
 * ```
 */
export function MediaRenderer(props: RendererProps & { kind: MediaPlayerProps['kind'] }): React.JSX.Element {
  const { kind, entry, source, isActive, onError, className, classNames } = props;
  return (
    <div {...partProps('media-viewer', classNames, className)}>
      {source.kind === 'url' && (
        <MediaPlayer
          kind={kind}
          url={source.url}
          withCredentials={source.withCredentials}
          isActive={isActive}
          label={entry.name}
          onError={onError}
          classNames={classNames}
        />
      )}
    </div>
  );
}
