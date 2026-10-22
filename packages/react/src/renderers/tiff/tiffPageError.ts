import type { ViewerErrorKind } from '../../viewer/errors';

/**
 * Why a page could not be drawn, as a viewer error kind (`too_large` when the browser cannot hold its
 * canvas).
 *
 * @example
 * ```ts
 * const kind = thrown instanceof TiffPageError ? thrown.kind : 'load_error';
 * ```
 */
export class TiffPageError extends Error {
  /** The viewer error kind whose message the page shows. */
  readonly kind: ViewerErrorKind;
  constructor(kind: ViewerErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
