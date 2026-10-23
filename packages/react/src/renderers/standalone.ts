'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import type { ClassNames, Part } from '../parts';
import { viewerError, type ViewerError } from '../viewer/errors';
import { mediaUrlOfBlob, safeUrlOrNull } from './safeUrls';
import { useLatest } from './useLatest';

/**
 * Props every standalone renderer takes. `src` is a URL (fetched by the renderer) or the file's bytes, read
 * locally. `theme` pins the color scheme (`data-theme` on the root); `'system'` (the default) follows the
 * OS. No `FileSystemProvider` is needed. A renderer package passes its own part union as `P`, so
 * `classNames` accepts exactly its parts.
 *
 * @example
 * ```tsx
 * const props: StandaloneViewerProps = { src: file, fileName: file.name, theme: 'dark' };
 * ```
 */
export interface StandaloneViewerProps<P extends string = Part> {
  src: string | Blob | ArrayBuffer | Uint8Array;
  fileName?: string;
  className?: string;
  classNames?: ClassNames<P>;
  style?: CSSProperties;
  theme?: 'light' | 'dark' | 'system';
  onError?: (error: ViewerError) => void;
}

/**
 * Where a standalone renderer's file is: still loading, loaded (with the fields `Ready` names), or failed.
 *
 * @example
 * ```ts
 * const isShown = (file: StandaloneFile<{ data: ArrayBuffer }>): boolean => file.status === 'ready';
 * ```
 */
export type StandaloneFile<Ready> =
  { status: 'loading' } | ({ status: 'ready' } & Ready) | { status: 'error'; error: ViewerError };

/**
 * Where a standalone text renderer's file is: still loading, decoded (`text` and its size in bytes), or
 * failed.
 *
 * @example
 * ```ts
 * const shown = (file: StandaloneText): string => (file.status === 'ready' ? file.text : '');
 * ```
 */
export type StandaloneText = StandaloneFile<{ text: string; byteSize: number }>;

/**
 * What `useStandaloneText` and `useStandaloneBytes` return: the file to show, and whether it belongs to an
 * earlier `src` while the current one loads (show it read-only then, and report no edits).
 *
 * @example
 * ```ts
 * const { file, isLoadingNewSource }: StandaloneSource<{ data: ArrayBuffer }> =
 *   useStandaloneBytes(props.src, props.onError);
 * ```
 */
export interface StandaloneSource<Ready = { text: string; byteSize: number }> {
  file: StandaloneFile<Ready>;
  isLoadingNewSource: boolean;
}

interface LoadedSource<Ready> {
  src: StandaloneViewerProps['src'] | undefined;
  file: StandaloneFile<Ready>;
}

/**
 * The `data-theme` value for a standalone renderer's root: `undefined` for `'system'`, so the OS decides.
 *
 * @example
 * ```tsx
 * <div data-theme={themeAttribute(props.theme)} />
 * ```
 */
export function themeAttribute(theme: StandaloneViewerProps['theme']): 'light' | 'dark' | undefined {
  return theme === 'light' || theme === 'dark' ? theme : undefined;
}

class LargerThanMaxBytes extends Error {}

function refuseIfLargerThan(maxBytes: number, byteSize: number): void {
  if (byteSize > maxBytes) {
    throw new LargerThanMaxBytes(`${byteSize} bytes is over the ${maxBytes}-byte limit`);
  }
}

async function bodyWithin(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  refuseIfLargerThan(maxBytes, Number(response.headers.get('content-length')));
  const reader = (response.body ?? new Blob().stream()).getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    byteLength += read.value.byteLength;
    if (byteLength > maxBytes) await reader.cancel().catch(() => undefined);
    refuseIfLargerThan(maxBytes, byteLength);
    chunks.push(read.value);
  }
  const body = new Uint8Array(byteLength);
  for (let offset = 0, chunk = chunks.shift(); chunk; offset += chunk.byteLength, chunk = chunks.shift()) {
    body.set(chunk, offset);
  }
  return body.buffer;
}

async function bytesOf(
  src: StandaloneViewerProps['src'],
  signal: AbortSignal,
  maxBytes: number,
): Promise<ArrayBuffer | Uint8Array> {
  if (typeof src === 'string') {
    const response = await fetch(src, { signal });
    if (!response.ok) throw new Error(`GET ${src} answered ${response.status} ${response.statusText}`);
    return bodyWithin(response, maxBytes);
  }
  refuseIfLargerThan(maxBytes, src instanceof Blob ? src.size : src.byteLength);
  return src instanceof Blob ? src.arrayBuffer() : src;
}

const errorOfLoad = (thrown: unknown): ViewerError =>
  thrown instanceof LargerThanMaxBytes ? viewerError('too_large', thrown) : viewerError('load_error', thrown);

/**
 * Options of `useStandaloneText` and `useStandaloneBytes`. `maxBytes` refuses a larger file as `too_large`:
 * bytes and blobs are checked before they are read; a URL is checked by its `Content-Length` before its
 * body is read, then by the bytes received as they arrive, so reading stops (and the body is cancelled) as
 * soon as it passes `maxBytes`, whatever the header said.
 *
 * @example
 * ```ts
 * const options: StandaloneLoadOptions = { maxBytes: 10 * 1024 * 1024 };
 * ```
 */
export interface StandaloneLoadOptions {
  maxBytes?: number;
}

function useStandaloneFile<Ready>(
  src: StandaloneViewerProps['src'],
  onError: StandaloneViewerProps['onError'],
  readyFileOf: (bytes: ArrayBuffer | Uint8Array) => Ready,
  maxBytes = Number.POSITIVE_INFINITY,
): StandaloneSource<Ready> {
  const [loaded, setLoaded] = useState<LoadedSource<Ready>>({ src: undefined, file: { status: 'loading' } });
  const reportError = useLatest(onError);
  useEffect(() => {
    const controller = new AbortController();
    bytesOf(src, controller.signal, maxBytes).then(
      (bytes) => {
        if (controller.signal.aborted) return;
        setLoaded({ src, file: { status: 'ready', ...readyFileOf(bytes) } });
      },
      (thrown: unknown) => {
        if (controller.signal.aborted) return;
        const error = errorOfLoad(thrown);
        setLoaded({ src, file: { status: 'error', error } });
        reportError.current?.(error);
      },
    );
    return () => controller.abort();
  }, [src, reportError, readyFileOf, maxBytes]);
  return {
    file: loaded.file,
    isLoadingNewSource: loaded.src !== undefined && loaded.src !== src,
  };
}

const decodedText = (bytes: ArrayBuffer | Uint8Array): { text: string; byteSize: number } => ({
  text: new TextDecoder().decode(bytes),
  byteSize: bytes.byteLength,
});

const ownArrayBuffer = (bytes: ArrayBuffer | Uint8Array): { data: ArrayBuffer } => ({
  data: ArrayBuffer.isView(bytes) ? bytes.slice().buffer : bytes,
});

/**
 * Loads a standalone renderer's `src` as UTF-8 text: fetches a URL (aborted when `src` changes or on
 * unmount) or decodes the given bytes. While a new `src` loads, the previous file is still returned, with
 * `isLoadingNewSource`, so a new `src` object with the same content (such as an inline `new Blob(…)`)
 * changes nothing on screen. A failure replaces the file with `load_error` (`too_large` past
 * `options.maxBytes`) and is passed to `onError`.
 *
 * @example
 * ```tsx
 * const { file } = useStandaloneText(props.src, props.onError);
 * if (file.status === 'ready') return <pre>{file.text}</pre>;
 * ```
 */
export function useStandaloneText(
  src: StandaloneViewerProps['src'],
  onError: StandaloneViewerProps['onError'],
  options?: StandaloneLoadOptions,
): StandaloneSource {
  return useStandaloneFile(src, onError, decodedText, options?.maxBytes);
}

/**
 * Loads a standalone renderer's `src` as an `ArrayBuffer`, like `useStandaloneText` but without decoding: a
 * `Uint8Array` is copied into a buffer of its own, an `ArrayBuffer` is used as given. With
 * `options.maxBytes`, a larger file is `too_large` and is not read (a URL whose size is unknown is read only
 * until it passes `maxBytes`).
 *
 * @example
 * ```tsx
 * const { file } = useStandaloneBytes(props.src, props.onError);
 * if (file.status === 'ready') return <p>{file.data.byteLength} bytes</p>;
 * ```
 */
export function useStandaloneBytes(
  src: StandaloneViewerProps['src'],
  onError: StandaloneViewerProps['onError'],
  options?: StandaloneLoadOptions,
): StandaloneSource<{ data: ArrayBuffer }> {
  return useStandaloneFile(src, onError, ownArrayBuffer, options?.maxBytes);
}

/**
 * Where a standalone image, audio or video renderer's file is: still loading, ready to show from `url`, or
 * failed.
 *
 * @example
 * ```ts
 * const urlOf = (media: StandaloneUrl): string | undefined =>
 *   media.status === 'ready' ? media.url : undefined;
 * ```
 */
export type StandaloneUrl =
  { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; error: ViewerError };

async function mediaUrlOf(
  src: StandaloneViewerProps['src'],
  fileName: string,
  signal: AbortSignal,
): Promise<{ url: string; objectUrl?: string }> {
  if (typeof src === 'string') {
    const safe = safeUrlOrNull(src);
    if (safe === null) throw new Error(`"${src}" is not an http, https or blob URL; pass one of those`);
    return { url: safe };
  }
  const blob = src instanceof Blob ? src : new Blob([ArrayBuffer.isView(src) ? src.slice() : src]);
  return mediaUrlOfBlob(blob, fileName, signal);
}

interface LoadedUrl {
  media: StandaloneUrl;
  objectUrl: string | undefined;
}

function useObjectUrlRevokedWhenReplaced(objectUrl: string | undefined): void {
  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);
}

/**
 * The URL a standalone image, audio or video renderer shows `src` from. A string must be an http, https or
 * blob URL (anything else is `load_error`). Bytes become an object URL typed so it cannot render as a page
 * (or a `data:` URL for an SVG named `*.svg`); it is revoked once the next one has been committed (so the
 * element is never left pointing at a revoked URL) and on unmount. `reportError` records a failure the
 * element reports (such as `unsupported_media`) and passes it to `onError`.
 *
 * @example
 * ```tsx
 * const { media, reportError } = useStandaloneUrl(props.src, props.fileName, props.onError);
 * const failed = (): void => reportError(viewerError('load_error'));
 * if (media.status === 'ready') return <audio src={media.url} onError={failed} />;
 * ```
 */
export function useStandaloneUrl(
  src: StandaloneViewerProps['src'],
  fileName: string | undefined,
  onError: StandaloneViewerProps['onError'],
): { media: StandaloneUrl; reportError: (error: ViewerError) => void } {
  const [loaded, setLoaded] = useState<LoadedUrl>({ media: { status: 'loading' }, objectUrl: undefined });
  const onErrorRef = useLatest(onError);
  useObjectUrlRevokedWhenReplaced(loaded.objectUrl);
  const reportError = (error: ViewerError): void => {
    setLoaded((previous) => ({ ...previous, media: { status: 'error', error } }));
    onErrorRef.current?.(error);
  };
  useEffect(() => {
    const controller = new AbortController();
    mediaUrlOf(src, fileName ?? '', controller.signal).then(
      (made) => {
        if (!controller.signal.aborted) {
          setLoaded({ media: { status: 'ready', url: made.url }, objectUrl: made.objectUrl });
        } else if (made.objectUrl) URL.revokeObjectURL(made.objectUrl);
      },
      (thrown: unknown) => {
        if (controller.signal.aborted) return;
        const error = viewerError('load_error', thrown);
        setLoaded((previous) => ({ ...previous, media: { status: 'error', error } }));
        onErrorRef.current?.(error);
      },
    );
    return () => controller.abort();
  }, [src, fileName, onErrorRef]);
  return { media: loaded.media, reportError };
}
