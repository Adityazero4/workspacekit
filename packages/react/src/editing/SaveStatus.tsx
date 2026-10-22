'use client';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import type { SaveStatusKind } from './autosaver';

const LABELS: Record<SaveStatusKind, string> = {
  idle: '',
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  error: "Couldn't save.",
  conflict: 'Changed by someone else',
  deleted: 'Deleted',
};

const ANNOUNCEMENTS: Partial<Record<SaveStatusKind, string>> = {
  saved: 'Saved',
  error: "Couldn't save.",
};

/**
 * Props of `SaveStatus`.
 *
 * @example
 * ```tsx
 * const props: SaveStatusProps = { status: 'error', onRetry: () => void autosave.flush() };
 * ```
 */
export interface SaveStatusProps {
  status: SaveStatusKind;
  /** Saves again; offered while `status` is `error`. */
  onRetry: () => void;
  classNames?: ClassNames;
}

/**
 * The save status of an edited file (the `viewer-save-status` part): "Unsaved", "Saving…", "Saved",
 * "Couldn't save." with a Retry button, "Changed by someone else" or "Deleted", and empty while nothing is
 * edited. A visually hidden polite live region beside it (the `save-announcement` part) announces only
 * "Saved" and "Couldn't save.", once per change: typing and saving are not announced, and a conflict or
 * deletion is left to the `role="alert"` banner that offers the choices.
 *
 * @example
 * ```tsx
 * <SaveStatus status={status} onRetry={() => void flush()} />
 * ```
 */
export function SaveStatus(props: SaveStatusProps): React.JSX.Element {
  const { status, onRetry, classNames } = props;
  return (
    <>
      <span {...partProps('viewer-save-status', classNames)}>
        {LABELS[status]}
        {status === 'error' && (
          <>
            {' '}
            <button type="button" {...partProps('save-retry', classNames)} onClick={onRetry}>
              Retry
            </button>
          </>
        )}
      </span>
      <span role="status" aria-live="polite" {...partProps('save-announcement', classNames)}>
        {ANNOUNCEMENTS[status]}
      </span>
    </>
  );
}
