'use client';
import { partProps } from '../cx';
import type { TreeDragHandlers } from '../dnd/useTreeDnd';
import { Icons } from '../icons';
import type { ClassNames } from '../parts';
import type { PlaceholderRow } from '../tree/rowLayout';

/**
 * Props of `UploadPlaceholderRow`.
 *
 * @example
 * ```tsx
 * const props: UploadPlaceholderRowProps = { placeholder, offset: 48, drag: dnd.handlers };
 * ```
 */
export interface UploadPlaceholderRowProps {
  placeholder: PlaceholderRow;
  /** The row's top in pixels, from the virtualizer. */
  offset: number;
  /** A drag over the placeholder targets its folder, as over that folder's rows. */
  drag: Pick<TreeDragHandlers, 'dragOver' | 'drop'>;
  classNames?: ClassNames;
}

/**
 * A row standing in for an item that is still uploading: its name and the run's progress, marked
 * `data-pending`. Hidden from assistive technology and never focusable, so the tree's items and keyboard
 * model stay as they are; `UploadStatus` announces the progress instead.
 *
 * @example
 * ```tsx
 * <UploadPlaceholderRow
 *   key={placeholder.key}
 *   placeholder={placeholder}
 *   offset={item.start}
 *   drag={dnd.handlers}
 * />
 * ```
 */
export function UploadPlaceholderRow(props: UploadPlaceholderRowProps): React.JSX.Element {
  const { placeholder, offset, drag, classNames } = props;
  return (
    <div
      {...partProps('tree-row-placeholder', classNames)}
      data-pending=""
      aria-hidden="true"
      onDragOver={(event) => drag.dragOver(event, placeholder.target)}
      onDrop={(event) => drag.drop(event, placeholder.target)}
      style={{
        transform: `translateY(${offset}px)`,
        paddingInlineStart: `calc(${placeholder.depth} * var(--fs-indent))`,
      }}
    >
      <span {...partProps('tree-chevron', classNames)} />
      <span {...partProps('tree-row-icon', classNames)}>
        <Icons.Spinner />
      </span>
      <span {...partProps('tree-row-label', classNames)}>{placeholder.name}</span>
      <span {...partProps('upload-progress', classNames)}>{placeholder.percent}%</span>
    </div>
  );
}
