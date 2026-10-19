'use client';
import { fromFileList, type UploadItem } from '@scope/core';
import { useRef, type ChangeEvent } from 'react';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';

/**
 * Which file picker to open: files (several at once) or one folder with everything in it.
 *
 * @example
 * ```ts
 * const kind: UploadPickerKind = 'folder';
 * ```
 */
export type UploadPickerKind = 'files' | 'folder';

/**
 * What `useUploadInputs` returns: the hidden inputs to render once, and `pick` to open one of them.
 *
 * @example
 * ```tsx
 * const { inputs, pick } = useUploadInputs({ enabled: true, onPicked: upload });
 * ```
 */
export interface UploadInputs {
  /** The two hidden `<input type="file">` elements, or `null` when uploads are disabled. */
  inputs: React.JSX.Element | null;
  /** Opens the file or folder picker; the selection is uploaded into `targetDir`. */
  pick: (kind: UploadPickerKind, targetDir: string) => void;
}

const FOLDER_PICKER_ATTRIBUTES = { webkitdirectory: '' };

/**
 * Hidden file inputs for the Upload files and Upload folder actions, rendered once per tree rather than per
 * row. The folder input uses `webkitdirectory`, so each file keeps its path inside the folder. The input is
 * cleared after every selection, so picking the same files again uploads them again.
 *
 * @example
 * ```tsx
 * const { inputs, pick } = useUploadInputs({ enabled: adapter.upload !== undefined, onPicked: startUpload });
 * return <>{inputs}<button onClick={() => pick('files', 'inbox')}>Upload</button></>;
 * ```
 */
export function useUploadInputs(options: {
  enabled: boolean;
  onPicked: (items: UploadItem[], targetDir: string) => void;
  classNames?: ClassNames;
}): UploadInputs {
  const { enabled, onPicked, classNames } = options;
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pickedTargetDir = useRef('');
  const uploadSelection = (event: ChangeEvent<HTMLInputElement>): void => {
    const items = fromFileList(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = '';
    if (items.length > 0) onPicked(items, pickedTargetDir.current);
  };
  const pick = (kind: UploadPickerKind, targetDir: string): void => {
    pickedTargetDir.current = targetDir;
    (kind === 'files' ? filesInput : folderInput).current?.click();
  };
  const inputs = enabled ? (
    <>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        {...partProps('upload-input', classNames)}
        onChange={uploadSelection}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        {...FOLDER_PICKER_ATTRIBUTES}
        {...partProps('upload-input', classNames)}
        onChange={uploadSelection}
      />
    </>
  ) : null;
  return { inputs, pick };
}
