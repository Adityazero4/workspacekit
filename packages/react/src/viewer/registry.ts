import type { Entry } from '@scope/core';
import type { ComponentType } from 'react';
import type { ClassNames } from '../parts';
import type { ViewerError } from './errors';

export { viewerError } from './errors';
export type { ViewerError, ViewerErrorKind } from './errors';

/**
 * An {@link Entry} plus the lower-cased name parts renderers match on. `extension` is `''` for
 * extensionless names and dotfiles such as `.env`.
 *
 * @example
 * ```ts
 * const isMarkdown = (file: FileInfo): boolean => file.extension === 'md' || file.basename === 'readme';
 * ```
 */
export interface FileInfo extends Entry {
  extension: string;
  basename: string;
}

/**
 * What a renderer wants to be given: a URL, a `Blob`, an `ArrayBuffer`, decoded text, or nothing.
 *
 * @example
 * ```ts
 * const input: RendererInput = 'text';
 * ```
 */
export type RendererInput = 'url' | 'blob' | 'arrayBuffer' | 'text' | 'none';

/**
 * The file content handed to a renderer, in the shape its {@link RendererInput} asked for. A `url` source
 * (http, https, blob, or a `data:image/svg+xml` URL the viewer built) may only be the `src` of an `img`,
 * `audio`, `video` or a sandboxed `iframe`; never navigate to it or open it in a window.
 *
 * @example
 * ```ts
 * const source: RendererSource = { kind: 'text', text: 'hello' };
 * ```
 */
export type RendererSource =
  | { kind: 'url'; url: string; withCredentials: boolean }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'arrayBuffer'; data: ArrayBuffer }
  | { kind: 'text'; text: string }
  | { kind: 'none' };

/**
 * The props every renderer component receives.
 *
 * @example
 * ```tsx
 * function Plain({ source }: RendererProps): React.JSX.Element {
 *   return <pre>{source.kind === 'text' ? source.text : ''}</pre>;
 * }
 * ```
 */
export interface RendererProps {
  /** The file shown; `entry.path` follows renames and moves without remounting the renderer. */
  entry: Entry;
  /** The content, in the shape `Renderer.input` asked for. */
  source: RendererSource;
  /**
   * The `mtimeMs` of the version `source` holds (`undefined` when the adapter gives none). It changes
   * together with `source` when a newer version loads, so a renderer can tell a new version from a re-render.
   */
  version: number | undefined;
  /** The view mode picked from `Renderer.modes` (the first by default); `undefined` without modes. */
  mode: string | undefined;
  /**
   * False while the viewer is hidden, such as a background tab, which stays mounted: pause media and stop
   * any ongoing work (timers, decoding, observers) until it is true again.
   */
  isActive: boolean;
  /** True unless the renderer is `editable`, the source is text and the adapter can write. */
  readOnly: boolean;
  /** Receives the whole edited text on every edit; set only while `readOnly` is false. */
  onChange?: (text: string) => void;
  /** Opens another entry, such as a directory listing's row. */
  onOpenEntry?: (path: string) => void;
  /**
   * Reports content the renderer cannot show (corrupt, unsupported or password protected), with
   * `viewerError`. For the first version it shows, the error replaces the renderer with an error view
   * (Retry remounts it); after it has shown an earlier version, the error is a banner above the content
   * and the renderer stays, keeping that version on screen. A thrown render error is a `load_error`.
   */
  onError: (error: ViewerError) => void;
  /** Saves the file to the user's device; set only when the viewer can download it. */
  onDownload?: () => void;
  className?: string;
  classNames?: ClassNames;
}

/**
 * Describes how to show one family of files: when it applies (`match`), how to load its component, and
 * which content shape it needs. Define renderers as module-level constants: the viewer caches each one's
 * loaded component by object identity, so a renderer object created during render loads its code again and
 * remounts on every render.
 *
 * @example
 * ```tsx
 * // CsvRenderer.tsx
 * export default function CsvRenderer({ source, isActive }: RendererProps): React.JSX.Element {
 *   const rows = source.kind === 'text' ? source.text.split('\n').map((line) => line.split(',')) : [];
 *   return <CsvTable rows={rows} animate={isActive} />;
 * }
 *
 * // renderers.ts
 * export const csvRenderer = defineRenderer({
 *   id: 'csv',
 *   match: (file) => file.extension === 'csv' && MATCH_SCORE.specific,
 *   load: () => import('./CsvRenderer'),
 *   input: 'text',
 *   maxBytes: 5 * 1024 * 1024,
 * });
 *
 * // App.tsx
 * <FileViewer path={path} renderers={[csvRenderer, ...lightRenderers]} />
 * ```
 */
export interface Renderer {
  /** A unique, stable name. */
  id: string;
  /** How well the renderer fits `file`: a `MATCH_SCORE`, or `false` when it does not apply. */
  match: (file: FileInfo) => number | false;
  /** Loads the component (the module's default export) the first time a file needs it. */
  load: () => Promise<{ default: ComponentType<RendererProps> }>;
  /** The shape `source` takes; `none` reads nothing. */
  input: RendererInput;
  /**
   * The largest file the renderer accepts, in bytes. A file whose `entry.size` is larger is `too_large` and
   * never read; when the size is unknown, the bytes read are checked instead (text by its UTF-8 bytes). A
   * `url` input streamed from `adapter.url` is not gated.
   */
  maxBytes?: number;
  /** View modes, such as preview and source; the chosen one arrives as `RendererProps.mode`. */
  modes?: readonly { value: string; label: string }[];
  /** Whether the renderer can edit; it requires `input: 'text'`, and edits arrive through `onChange`. */
  editable?: boolean;
}

/**
 * The type of {@link MATCH_SCORE}: the score a renderer's `match` returns, by how specific the match is.
 *
 * @example
 * ```ts
 * const score: MatchScore['specific'] = 20;
 * ```
 */
export interface MatchScore {
  readonly fallback: 1;
  readonly text: 5;
  readonly generic: 10;
  readonly specific: 20;
  readonly directory: 100;
}

/**
 * Scores for `Renderer.match`. The highest score wins, so `specific` (an exact extension) beats `generic`
 * (a content family) beats `text` (any readable text) beats `fallback`.
 *
 * @example
 * ```ts
 * const match = (file: FileInfo): number | false => file.extension === 'png' && MATCH_SCORE.specific;
 * ```
 */
export const MATCH_SCORE: MatchScore = Object.freeze({
  fallback: 1,
  text: 5,
  generic: 10,
  specific: 20,
  directory: 100,
} as const);

/**
 * Returns the renderer unchanged; use it to get the `Renderer` type checked where the object is written.
 *
 * @example
 * ```ts
 * const markdown = defineRenderer({
 *   id: 'markdown',
 *   match: (file) => file.extension === 'md' && MATCH_SCORE.specific,
 *   load: () => import('./MarkdownRenderer'),
 *   input: 'text',
 *   modes: [{ value: 'preview', label: 'Preview' }],
 * });
 * ```
 */
export function defineRenderer(renderer: Renderer): Renderer {
  return renderer;
}

function extensionOf(lowerCasedName: string): string {
  const lastDot = lowerCasedName.lastIndexOf('.');
  return lastDot <= 0 ? '' : lowerCasedName.slice(lastDot + 1);
}

/**
 * Adds the lower-cased `basename` (the whole file name) and `extension` (text after the last dot) that
 * renderers match on.
 *
 * @example
 * ```ts
 * fileInfo({ path: 'a.TAR.GZ', name: 'a.TAR.GZ', kind: 'file' }).extension; // 'gz'
 * ```
 */
export function fileInfo(entry: Entry): FileInfo {
  const basename = entry.name.toLowerCase();
  return { ...entry, basename, extension: extensionOf(basename) };
}

/**
 * Picks the renderer whose `match` scores highest for the entry. A tie goes to the earlier renderer in the
 * list; `match` returning `false` skips a renderer. Returns `undefined` when none match.
 *
 * @example
 * ```ts
 * const renderer = resolveRenderer(entry, [imageRenderer, textRenderer, unsupportedRenderer]);
 * ```
 */
export function resolveRenderer(entry: Entry, renderers: readonly Renderer[]): Renderer | undefined {
  const file = fileInfo(entry);
  let best: Renderer | undefined;
  let bestScore = 0;
  for (const renderer of renderers) {
    const score = renderer.match(file);
    if (score !== false && score > bestScore) {
      best = renderer;
      bestScore = score;
    }
  }
  return best;
}
