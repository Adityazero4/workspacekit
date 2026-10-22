import {
  AUDIO_EXTENSIONS,
  HTML_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_BASENAMES,
  TEXT_EXTENSIONS,
  TIFF_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './fileKinds';
import { defineRenderer, MATCH_SCORE, type FileInfo, type Renderer } from './registry';

const MIB = 1024 * 1024;
const TEXT_MAX_BYTES = 10 * MIB;
const HTML_MAX_BYTES = 5 * MIB;
const IMAGE_MAX_BYTES = 100 * MIB;
const MEDIA_MAX_BYTES = 200 * MIB;
const TIFF_MAX_BYTES = 200 * MIB;

const isEnvFile = (basename: string): boolean => basename === '.env' || basename.startsWith('.env.');

const fileWithExtensionIn =
  (extensions: ReadonlySet<string>) =>
  (file: FileInfo): number | false =>
    file.kind === 'file' && extensions.has(file.extension) && MATCH_SCORE.generic;

const isText = (file: FileInfo): boolean =>
  TEXT_EXTENSIONS.has(file.extension) || TEXT_BASENAMES.has(file.basename) || isEnvFile(file.basename);

/**
 * Plain text, configuration and source files (by extension, by well-known names such as `Makefile`, and
 * `.env` or `.env.*`), up to 10 MiB. Editable up to 1 MiB; larger files show in a read-only line view.
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'Makefile', name: 'Makefile', kind: 'file' }, [textRenderer])?.id; // 'text'
 * ```
 */
export const textRenderer: Renderer = defineRenderer({
  id: 'text',
  match: (file) => file.kind === 'file' && isText(file) && MATCH_SCORE.text,
  load: () => import('../renderers/text/TextViewer'),
  input: 'text',
  maxBytes: TEXT_MAX_BYTES,
  editable: true,
});

/**
 * HTML documents, up to 5 MiB, in two modes: `preview` (the default; the page in a frame sandboxed to
 * `allow-scripts`, with no `allow-same-origin`) and `source` (the text editor, editable under its rules).
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'index.html', name: 'index.html', kind: 'file' }, lightRenderers)?.id; // 'html'
 * ```
 */
export const htmlRenderer: Renderer = defineRenderer({
  id: 'html',
  match: fileWithExtensionIn(HTML_EXTENSIONS),
  load: () => import('../renderers/html/HtmlViewer'),
  input: 'text',
  maxBytes: HTML_MAX_BYTES,
  editable: true,
  modes: [
    { value: 'preview', label: 'Preview' },
    { value: 'source', label: 'Source' },
  ],
});

/**
 * Images a browser can draw (PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, ICO), with zoom, pan and rotate. Streams
 * from `adapter.url` when there is one; otherwise reads the file, up to 100 MiB.
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'logo.svg', name: 'logo.svg', kind: 'file' }, lightRenderers)?.id; // 'image'
 * ```
 */
export const imageRenderer: Renderer = defineRenderer({
  id: 'image',
  match: fileWithExtensionIn(IMAGE_EXTENSIONS),
  load: () => import('../renderers/image/ImageViewer'),
  input: 'url',
  maxBytes: IMAGE_MAX_BYTES,
});

/**
 * TIFF images, single or multi-page, up to 200 MiB, laid out from their tags and decoded page by page as
 * they scroll into view. Scores `specific`, so it wins over the image renderer for `.tif` and `.tiff`.
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'scan.tiff', name: 'scan.tiff', kind: 'file' }, lightRenderers)?.id; // 'tiff'
 * ```
 */
export const tiffRenderer: Renderer = defineRenderer({
  id: 'tiff',
  match: (file) => file.kind === 'file' && TIFF_EXTENSIONS.has(file.extension) && MATCH_SCORE.specific,
  load: () => import('../renderers/tiff/TiffViewer'),
  input: 'arrayBuffer',
  maxBytes: TIFF_MAX_BYTES,
});

/**
 * Audio in the browser's native player. Streams from `adapter.url` when there is one; otherwise reads the
 * file, up to 200 MiB.
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'call.mp3', name: 'call.mp3', kind: 'file' }, lightRenderers)?.id; // 'audio'
 * ```
 */
export const audioRenderer: Renderer = defineRenderer({
  id: 'audio',
  match: fileWithExtensionIn(AUDIO_EXTENSIONS),
  load: () => import('../renderers/media/AudioViewer'),
  input: 'url',
  maxBytes: MEDIA_MAX_BYTES,
});

/**
 * Video in the browser's native player. Streams from `adapter.url` when there is one; otherwise reads the
 * file, up to 200 MiB.
 *
 * @example
 * ```ts
 * resolveRenderer({ path: 'demo.mp4', name: 'demo.mp4', kind: 'file' }, lightRenderers)?.id; // 'video'
 * ```
 */
export const videoRenderer: Renderer = defineRenderer({
  id: 'video',
  match: fileWithExtensionIn(VIDEO_EXTENSIONS),
  load: () => import('../renderers/media/VideoViewer'),
  input: 'url',
  maxBytes: MEDIA_MAX_BYTES,
});

/**
 * Every directory: its children with name, size and modified columns, opened with `onOpenEntry`.
 *
 * @example
 * ```tsx
 * const viewer = useFileViewer('src', { renderers: [directoryRenderer] });
 * ```
 */
export const directoryRenderer: Renderer = defineRenderer({
  id: 'directory',
  match: (file) => file.kind === 'directory' && MATCH_SCORE.directory,
  load: () => import('../renderers/directory/DirectoryViewer'),
  input: 'none',
});

/**
 * The fallback for any file no other renderer matches: its name and size, and Download when possible.
 *
 * @example
 * ```ts
 * const renderers: Renderer[] = [...myRenderers, unsupportedRenderer];
 * ```
 */
export const unsupportedRenderer: Renderer = defineRenderer({
  id: 'unsupported',
  match: () => MATCH_SCORE.fallback,
  load: () => import('../renderers/unsupported/UnsupportedViewer'),
  input: 'none',
});

/**
 * The built-in renderers, each loaded on first use: text, HTML, image, TIFF, audio, video, directory and the
 * unsupported fallback.
 *
 * @example
 * ```ts
 * const viewer = useFileViewer(path, { renderers: [markdownRenderer, ...lightRenderers] });
 * ```
 */
export const lightRenderers: readonly Renderer[] = [
  textRenderer,
  htmlRenderer,
  imageRenderer,
  tiffRenderer,
  audioRenderer,
  videoRenderer,
  directoryRenderer,
  unsupportedRenderer,
];
