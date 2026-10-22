'use client';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import type { RendererProps } from '../../viewer/registry';
import { formatBytes } from '../format';

/**
 * Props of `UnsupportedViewer`. The Download button shows only when `onDownload` is set.
 *
 * @example
 * ```tsx
 * const props: UnsupportedViewerProps = { fileName: 'archive.bin', size: 2048, onDownload: save };
 * ```
 */
export interface UnsupportedViewerProps {
  fileName: string;
  size?: number | null;
  onDownload?: () => void;
  className?: string;
  classNames?: ClassNames;
}

/**
 * What a viewer shows for a file it cannot preview: the name, the size when known, "No preview for this
 * file type." and a Download button when `onDownload` is set. Needs no `FileSystemProvider`.
 *
 * @example
 * ```tsx
 * <UnsupportedViewer fileName="archive.bin" size={2048} onDownload={() => save(file)} />
 * ```
 */
export function UnsupportedViewer(props: UnsupportedViewerProps): React.JSX.Element {
  const { fileName, size, onDownload, className, classNames } = props;
  return (
    <div {...partProps('viewer-unsupported', classNames, className)}>
      <p {...partProps('viewer-unsupported-name', classNames)}>{fileName}</p>
      {typeof size === 'number' && (
        <p {...partProps('viewer-unsupported-size', classNames)}>{formatBytes(size)}</p>
      )}
      <p {...partProps('viewer-unsupported-message', classNames)}>No preview for this file type.</p>
      {onDownload && (
        <button type="button" {...partProps('viewer-unsupported-download', classNames)} onClick={onDownload}>
          Download
        </button>
      )}
    </div>
  );
}

/**
 * The unsupported renderer component the registry loads: `UnsupportedViewer` for the entry, with the
 * viewer's `onDownload`.
 *
 * @example
 * ```tsx
 * const { default: UnsupportedRenderer } = await unsupportedRenderer.load();
 * ```
 */
export default function UnsupportedRenderer(props: RendererProps): React.JSX.Element {
  const { entry, onDownload, className, classNames } = props;
  return (
    <UnsupportedViewer
      fileName={entry.name}
      size={entry.size}
      onDownload={onDownload}
      className={className}
      classNames={classNames}
    />
  );
}
