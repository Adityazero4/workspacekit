/**
 * Why a viewer could not show a file.
 *
 * @example
 * ```ts
 * const kind: ViewerErrorKind = 'too_large';
 * ```
 */
export type ViewerErrorKind =
  'not_found' | 'load_error' | 'password_protected' | 'unsupported_media' | 'too_large' | 'deleted';

/**
 * A viewer failure: a machine-readable `kind` and a `message` that is safe to show the user.
 *
 * @example
 * ```ts
 * const error: ViewerError = { kind: 'deleted', message: 'This file was deleted.' };
 * ```
 */
export interface ViewerError {
  kind: ViewerErrorKind;
  message: string;
  cause?: unknown;
}

const VIEWER_ERROR_MESSAGES: Record<ViewerErrorKind, string> = {
  not_found: 'This file no longer exists. It may have been moved or deleted.',
  load_error: "This file couldn't be opened. Try again, or download it.",
  password_protected: "This file is password-protected and can't be previewed. Download it to open it.",
  unsupported_media: "Your browser can't play this format. Download it to open it in another app.",
  too_large: 'This file is too large to preview. Download it instead.',
  deleted: 'This file was deleted.',
};

/**
 * Builds the {@link ViewerError} for a kind, with the standard user-facing message. Pass the original
 * error as `cause` to keep it for debugging.
 *
 * @example
 * ```ts
 * onError(viewerError('load_error', thrown));
 * ```
 */
export function viewerError(kind: ViewerErrorKind, cause?: unknown): ViewerError {
  const error: ViewerError = { kind, message: VIEWER_ERROR_MESSAGES[kind] };
  if (cause !== undefined) error.cause = cause;
  return error;
}
