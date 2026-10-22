'use client';
import type { RendererProps } from '../../viewer/registry';
import type { StandaloneViewerProps } from '../standalone';
import { MediaRenderer, StandaloneMedia } from './MediaPlayer';

/**
 * Plays audio without a `FileSystemProvider`, in the browser's native `<audio>` player. `src` is an http,
 * https or blob URL, or the file's bytes. A format the browser can't play shows `unsupported_media`.
 *
 * @example
 * ```tsx
 * <AudioViewer src={file} fileName={file.name} />
 * ```
 */
export function AudioViewer(props: StandaloneViewerProps): React.JSX.Element {
  return <StandaloneMedia {...props} kind="audio" />;
}

/**
 * The audio renderer component the registry loads: a native `<audio>` for a viewer's `url` source. It pauses
 * when its tab becomes inactive, and a new version keeps the playback position and paused state.
 *
 * @example
 * ```tsx
 * const { default: AudioRenderer } = await audioRenderer.load();
 * ```
 */
export default function AudioRenderer(props: RendererProps): React.JSX.Element {
  return <MediaRenderer {...props} kind="audio" />;
}
