'use client';
import type { RendererProps } from '../../viewer/registry';
import type { StandaloneViewerProps } from '../standalone';
import { MediaRenderer, StandaloneMedia } from './MediaPlayer';

/**
 * Plays video without a `FileSystemProvider`, in the browser's native `<video>` player. `src` is an http,
 * https or blob URL, or the file's bytes. A format the browser can't play shows `unsupported_media`.
 *
 * @example
 * ```tsx
 * <VideoViewer src={file} fileName={file.name} />
 * ```
 */
export function VideoViewer(props: StandaloneViewerProps): React.JSX.Element {
  return <StandaloneMedia {...props} kind="video" />;
}

/**
 * The video renderer component the registry loads: a native `<video>` for a viewer's `url` source. It pauses
 * when its tab becomes inactive, and a new version keeps the playback position and paused state.
 *
 * @example
 * ```tsx
 * const { default: VideoRenderer } = await videoRenderer.load();
 * ```
 */
export default function VideoRenderer(props: RendererProps): React.JSX.Element {
  return <MediaRenderer {...props} kind="video" />;
}
