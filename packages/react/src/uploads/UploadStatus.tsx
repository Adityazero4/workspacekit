'use client';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { useUiValue } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { useUploads, type UploadRun } from './uploads';

/**
 * Props of `UploadStatus`.
 *
 * @example
 * ```tsx
 * const props: UploadStatusProps = { className: 'my-uploads', classNames: { 'upload-run': 'my-run' } };
 * ```
 */
export interface UploadStatusProps {
  className?: string;
  classNames?: ClassNames;
}

const RUN_LABEL: Record<UploadRun['status'], string> = {
  running: 'Uploading',
  done: 'Uploaded',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const runStatusAttribute = (run: UploadRun): 'loading' | 'error' | undefined => {
  if (run.status === 'running') return 'loading';
  return run.status === 'failed' ? 'error' : undefined;
};

const targetOf = (run: UploadRun): string => (run.targetDir === '' ? 'the root folder' : run.targetDir);
const runDescription = (run: UploadRun): string =>
  `${RUN_LABEL[run.status]} ${run.progress.done} of ${run.progress.total} to ${targetOf(run)}`;

/**
 * The upload list of the nearest `FileSystemProvider`: one item per run with its progress bar (while bytes
 * are moving) and a Cancel button (or Dismiss once it finished), each labelled with the run's target, plus a
 * polite live region that announces when a run starts, finishes, fails or is cancelled. Render it once,
 * anywhere under the provider.
 *
 * @example
 * ```tsx
 * <FileSystemProvider adapter={adapter}>
 *   <FileTree />
 *   <UploadStatus />
 * </FileSystemProvider>
 * ```
 */
export function UploadStatus(props: UploadStatusProps): React.JSX.Element {
  const { className, classNames } = props;
  const { runs, dismiss } = useUploads();
  const { uploads } = useFileSystemInternals();
  const announcement = useUiValue(uploads.announcement);
  return (
    <div {...partProps('upload-status', classNames, className)}>
      <p {...partProps('upload-summary', classNames)} role="status" aria-live="polite">
        {announcement}
      </p>
      {runs.length > 0 && (
        <ul {...partProps('upload-list', classNames)} aria-label="Uploads">
          {runs.map((run) => (
            <li key={run.id} {...partProps('upload-run', classNames)} data-status={runStatusAttribute(run)}>
              <span {...partProps('upload-label', classNames)}>{runDescription(run)}</span>
              {run.status === 'running' && run.progress.totalBytes > 0 && (
                <progress
                  {...partProps('upload-progress', classNames)}
                  value={run.progress.loadedBytes}
                  max={run.progress.totalBytes}
                  aria-label={runDescription(run)}
                />
              )}
              {run.status === 'running' ? (
                <button
                  type="button"
                  {...partProps('upload-button', classNames)}
                  aria-label={`Cancel upload to ${targetOf(run)}`}
                  onClick={run.cancel}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  {...partProps('upload-button', classNames)}
                  aria-label={`Dismiss upload to ${targetOf(run)}`}
                  onClick={() => dismiss(run.id)}
                >
                  Dismiss
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
