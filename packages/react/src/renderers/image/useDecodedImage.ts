'use client';
import { useEffect, useRef, useState } from 'react';
import { viewerError, type ViewerError } from '../../viewer/errors';
import { useLatest } from '../useLatest';
import type { ImageSize } from './useZoomPan';

const SIZE_OF_AN_IMAGE_WITHOUT_ONE: ImageSize = { width: 300, height: 150 };

/**
 * An image ready to show: its URL, already decoded, and its natural size (300 × 150 when it has none, as
 * for some SVGs).
 *
 * @example
 * ```ts
 * const image: DecodedImage = { url: 'blob:…', width: 800, height: 600 };
 * ```
 */
export interface DecodedImage extends ImageSize {
  url: string;
}

/**
 * Called when `url` cannot be decoded. `isStillShowingAnImage` is true when an earlier version stays on
 * screen (a failed refresh), false when there is nothing to show.
 *
 * @example
 * ```ts
 * const onDecodeError: DecodeErrorHandler = (error, isStillShowingAnImage) => report(error);
 * ```
 */
export type DecodeErrorHandler = (error: ViewerError, isStillShowingAnImage: boolean) => void;

/**
 * The image to show for `url`: `undefined` until the first URL has decoded, then always the latest URL that
 * decoded. A new `url` is decoded off screen (`img.decode()`) before it replaces the shown one, so swapping
 * never shows a blank frame; a `url` replaced or unmounted before it decodes has its load cancelled. A
 * failed decode keeps the image on screen and goes to `onError`.
 *
 * @example
 * ```tsx
 * const image = useDecodedImage(url, false, (error) => onError(error));
 * return image ? <img src={image.url} alt="" /> : null;
 * ```
 */
export function useDecodedImage(
  url: string,
  withCredentials: boolean,
  onError: DecodeErrorHandler,
): DecodedImage | undefined {
  const [decoded, setDecoded] = useState<DecodedImage | undefined>(undefined);
  const isShowingAnImage = useRef(false);
  const reportError = useLatest(onError);
  useEffect(() => {
    let isCurrent = true;
    const decoder = new Image();
    if (withCredentials) decoder.crossOrigin = 'use-credentials';
    decoder.src = url;
    decoder.decode().then(
      () => {
        if (!isCurrent) return;
        isShowingAnImage.current = true;
        const width = decoder.naturalWidth || SIZE_OF_AN_IMAGE_WITHOUT_ONE.width;
        const height = decoder.naturalHeight || SIZE_OF_AN_IMAGE_WITHOUT_ONE.height;
        setDecoded({ url, width, height });
      },
      (thrown: unknown) => {
        if (isCurrent) reportError.current(viewerError('load_error', thrown), isShowingAnImage.current);
      },
    );
    return () => {
      isCurrent = false;
      decoder.src = '';
    };
  }, [url, withCredentials, reportError]);
  return decoded;
}
