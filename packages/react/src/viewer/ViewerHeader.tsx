'use client';
import { basename } from '@workspacekit/core';
import type { ReactNode } from 'react';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import type { FileViewerState } from './useFileViewer';

/**
 * Props of `ViewerHeader`.
 *
 * @example
 * ```tsx
 * const props: ViewerHeaderProps = { state: useFileViewer(path, { renderers }), saveStatus: null };
 * ```
 */
export interface ViewerHeaderProps {
  state: FileViewerState;
  /** The save status, shown before Download. */
  saveStatus?: ReactNode;
  classNames?: ClassNames;
}

function ModeToggle(props: ViewerHeaderProps): React.JSX.Element {
  const { state, classNames } = props;
  return (
    <div role="group" aria-label="View mode" {...partProps('viewer-modes', classNames)}>
      {state.modes.map((option) => (
        <button
          key={option.value}
          type="button"
          {...partProps('viewer-mode', classNames)}
          aria-pressed={option.value === state.mode}
          onClick={() => state.setMode(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The default viewer header: the file name, the mode toggle (`aria-pressed` buttons in a "View mode" group,
 * when the renderer offers more than one mode), the save status, and Download when the file can be
 * downloaded.
 *
 * @example
 * ```tsx
 * <ViewerHeader state={viewer} />
 * ```
 */
export function ViewerHeader(props: ViewerHeaderProps): React.JSX.Element {
  const { state, saveStatus, classNames } = props;
  return (
    <div {...partProps('viewer-header', classNames)}>
      <span {...partProps('viewer-name', classNames)}>{state.entry?.name ?? basename(state.path)}</span>
      {state.modes.length > 1 && <ModeToggle state={state} classNames={classNames} />}
      {saveStatus}
      {state.download && (
        <button type="button" {...partProps('viewer-button', classNames)} onClick={state.download}>
          Download
        </button>
      )}
    </div>
  );
}
