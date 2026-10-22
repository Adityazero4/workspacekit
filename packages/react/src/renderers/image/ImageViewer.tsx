'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import type { ViewerError } from '../../viewer/errors';
import type { RendererProps } from '../../viewer/registry';
import { useStandaloneUrl, type StandaloneViewerProps } from '../standalone';
import { StandaloneRoot } from '../StandaloneRoot';
import { useSettledAnnouncement } from '../useSettledAnnouncement';
import { useDecodedImage, type DecodeErrorHandler, type DecodedImage } from './useDecodedImage';
import { useZoomPan, type ZoomPan } from './useZoomPan';

interface ImageViewProps {
  url: string;
  withCredentials: boolean;
  name: string;
  onError: DecodeErrorHandler;
  classNames: ClassNames | undefined;
}

interface Fullscreen {
  isEnabled: boolean;
  isFullscreen: boolean;
  toggle: () => void;
}

const crossOriginFor = (withCredentials: boolean): 'use-credentials' | undefined =>
  withCredentials ? 'use-credentials' : undefined;

function useFullscreen(target: RefObject<HTMLElement | null>): Fullscreen {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const follow = (): void =>
      setIsFullscreen(target.current !== null && document.fullscreenElement === target.current);
    document.addEventListener('fullscreenchange', follow);
    return () => document.removeEventListener('fullscreenchange', follow);
  }, [target]);
  const toggle = (): void => {
    const element = target.current;
    if (!element) return;
    const change =
      document.fullscreenElement === element ? document.exitFullscreen() : element.requestFullscreen();
    void change.catch(() => undefined).then(() => element.focus());
  };
  return { isEnabled: typeof document !== 'undefined' && document.fullscreenEnabled, isFullscreen, toggle };
}

interface ImageToolbarProps {
  zoomPan: ZoomPan;
  fullscreen: Fullscreen;
  classNames: ClassNames | undefined;
}

function ImageToolbar(props: ImageToolbarProps): React.JSX.Element {
  const { zoomPan, fullscreen, classNames } = props;
  const zoomLevel = `${Math.round(zoomPan.scale * 100)}%`;
  const announcement = useSettledAnnouncement(`Zoom ${zoomLevel}`);
  const button = partProps('image-button', classNames);
  return (
    <div {...partProps('image-toolbar', classNames)}>
      <button type="button" {...button} aria-label="Zoom out" onClick={zoomPan.zoomOut}>
        −
      </button>
      <span {...partProps('image-zoom-level', classNames)}>{zoomLevel}</span>
      <span {...partProps('image-zoom-status', classNames)} role="status">
        {announcement}
      </span>
      <button type="button" {...button} aria-label="Zoom in" onClick={zoomPan.zoomIn}>
        +
      </button>
      <button type="button" {...button} onClick={zoomPan.fit}>
        Fit
      </button>
      <button type="button" {...button} onClick={zoomPan.rotate}>
        Rotate
      </button>
      {fullscreen.isEnabled && (
        <button type="button" {...button} aria-pressed={fullscreen.isFullscreen} onClick={fullscreen.toggle}>
          Full screen
        </button>
      )}
    </div>
  );
}

function ZoomableImage(
  props: Omit<ImageViewProps, 'url' | 'onError'> & { image: DecodedImage },
): React.JSX.Element {
  const { image, withCredentials, name, classNames } = props;
  const surface = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const zoomPan = useZoomPan(image, { surface, stage });
  const fullscreen = useFullscreen(surface);
  return (
    <>
      <ImageToolbar zoomPan={zoomPan} fullscreen={fullscreen} classNames={classNames} />
      <div
        ref={surface}
        {...partProps('image-surface', classNames)}
        role="region"
        aria-label={name}
        aria-keyshortcuts="+ - 0 R"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must be focusable to be panned by keyboard
        tabIndex={0}
        data-zoomed={zoomPan.isZoomed ? '' : undefined}
        data-dragging={zoomPan.isDragging ? '' : undefined}
        {...zoomPan.surfaceHandlers}
      >
        <div ref={stage} {...partProps('image-stage', classNames)} style={zoomPan.stageStyle}>
          <img
            {...partProps('image-content', classNames)}
            src={image.url}
            alt={name}
            decoding="async"
            draggable={false}
            crossOrigin={crossOriginFor(withCredentials)}
            style={zoomPan.imageStyle}
          />
        </div>
      </div>
    </>
  );
}

function ImageView(props: ImageViewProps): React.JSX.Element | null {
  const { url, withCredentials, onError, ...shown } = props;
  const image = useDecodedImage(url, withCredentials, onError);
  return image ? <ZoomableImage {...shown} image={image} withCredentials={withCredentials} /> : null;
}

/**
 * Shows an image without a `FileSystemProvider`, with zoom (0.1× to 8×; Ctrl or ⌘ with the wheel zooms at
 * the cursor, a plain wheel scrolls the page), drag and arrow-key panning when zoomed, double-click to toggle
 * fit and 2×, the keys `+`, `-`, `0` (fit) and `r` (rotate), and full screen where the browser offers it.
 * `src` is an http, https or blob URL, or the image's bytes (an SVG needs a `fileName` ending in `.svg`). A
 * new `src` is decoded before it replaces the one on screen, keeping zoom and rotation; if it cannot be
 * decoded, the image on screen stays and the error goes to `onError`. The zoom level is announced once a
 * zoom gesture settles.
 *
 * @example
 * ```tsx
 * <ImageViewer src={file} fileName={file.name} theme="dark" />
 * ```
 */
export function ImageViewer(props: StandaloneViewerProps): React.JSX.Element {
  const { src, fileName, classNames, onError } = props;
  const { media, reportError } = useStandaloneUrl(src, fileName, onError);
  const [staleFailure, setStaleFailure] = useState<{ url: string; error: ViewerError }>();
  const shownUrl = media.status === 'ready' ? media.url : undefined;
  const onDecodeError = (error: ViewerError, isStillShowingAnImage: boolean): void => {
    if (!isStillShowingAnImage) {
      reportError(error);
      return;
    }
    if (shownUrl !== undefined) setStaleFailure({ url: shownUrl, error });
    onError?.(error);
  };
  return (
    <StandaloneRoot
      part="image-viewer"
      errorPart="image-error"
      state={media}
      viewer={props}
      staleError={staleFailure?.url === shownUrl ? staleFailure?.error : undefined}
    >
      {media.status === 'ready' && (
        <ImageView
          url={media.url}
          withCredentials={false}
          name={fileName ?? 'Image'}
          onError={onDecodeError}
          classNames={classNames}
        />
      )}
    </StandaloneRoot>
  );
}

/**
 * The image renderer component the registry loads: `ImageViewer`'s view for a viewer's `url` source. A new
 * version is decoded before it is swapped in, so there is no blank frame, and zoom and rotation are kept; a
 * version that cannot be decoded is reported through `onError`.
 *
 * @example
 * ```tsx
 * const { default: ImageRenderer } = await imageRenderer.load();
 * ```
 */
export default function ImageRenderer(props: RendererProps): React.JSX.Element {
  const { entry, source, onError, className, classNames } = props;
  return (
    <div {...partProps('image-viewer', classNames, className)}>
      {source.kind === 'url' && (
        <ImageView
          url={source.url}
          withCredentials={source.withCredentials}
          name={entry.name}
          onError={(error) => onError(error)}
          classNames={classNames}
        />
      )}
    </div>
  );
}
