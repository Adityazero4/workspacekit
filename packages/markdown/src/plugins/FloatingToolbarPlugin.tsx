'use client';
import { partProps } from '@scope/react/renderer-kit';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { MarkdownClassNames } from '../parts';
import { belowTheSelection } from './position';

const FORMATS: readonly { format: TextFormatType; label: string; symbol: string }[] = [
  { format: 'bold', label: 'Bold', symbol: 'B' },
  { format: 'italic', label: 'Italic', symbol: 'I' },
  { format: 'strikethrough', label: 'Strikethrough', symbol: 'S' },
  { format: 'code', label: 'Inline code', symbol: '</>' },
];

interface ToolbarState {
  top: number;
  left: number;
  active: TextFormatType[];
}

function toolbarFor(editor: LexicalEditor, container: HTMLElement): ToolbarState | null {
  const selection = $getSelection();
  if (!editor.isEditable() || !$isRangeSelection(selection) || selection.isCollapsed()) return null;
  const active = FORMATS.filter(({ format }) => selection.hasFormat(format)).map(({ format }) => format);
  return { ...belowTheSelection(container), active };
}

function focusButton(toolbar: HTMLElement, step: number): void {
  const buttons = [...toolbar.querySelectorAll('button')];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(current + step + buttons.length) % buttons.length]?.focus();
}

function useToolbarState(
  editor: LexicalEditor,
  container: HTMLElement,
  toolbar: { current: HTMLElement | null },
) {
  const [state, setState] = useState<ToolbarState | null>(null);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const next = editorState.read(() => toolbarFor(editor, container));
        const hasFocus = toolbar.current?.contains(document.activeElement) === true;
        setState((previous) => (hasFocus && previous && next ? { ...previous, active: next.active } : next));
      }),
    [editor, container, toolbar],
  );
  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          if (!event.altKey || event.key !== 'F10' || toolbar.current === null) return false;
          event.preventDefault();
          toolbar.current.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, toolbar],
  );
  return state;
}

/**
 * The format toolbar that appears under a text selection: bold, italic, strikethrough, inline code and
 * link. From the keyboard, Alt+F10 moves focus to it, the arrow keys move between its buttons (one tab
 * stop) and Escape returns to the text; the usual shortcuts (Mod+B, Mod+I) still work in the text.
 *
 * @example
 * ```tsx
 * <FloatingToolbarPlugin container={container} onEditLink={openLinkEditor} />
 * ```
 */
export function FloatingToolbarPlugin(props: {
  container: HTMLElement;
  onEditLink: () => void;
  classNames?: MarkdownClassNames;
}): React.JSX.Element | null {
  const { container, onEditLink, classNames } = props;
  const [editor] = useLexicalComposerContext();
  const toolbar = useRef<HTMLDivElement>(null);
  const state = useToolbarState(editor, container, toolbar);
  const [tabStop, setTabStop] = useState(0);
  if (state === null) return null;
  const rovingProps = (index: number): { tabIndex: number; onFocus: () => void } => ({
    tabIndex: index === tabStop ? 0 : -1,
    onFocus: () => setTabStop(index),
  });
  const onKeyDown = (event: KeyboardEvent): void => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined && event.key !== 'Escape') return;
    event.preventDefault();
    if (step === undefined) editor.focus();
    else focusButton(toolbar.current!, step);
  };
  return (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label="Format text"
      {...partProps('md-toolbar', classNames)}
      style={{ top: state.top, left: state.left }}
      onKeyDown={onKeyDown}
    >
      {FORMATS.map(({ format, label, symbol }, index) => (
        <button
          key={format}
          type="button"
          {...rovingProps(index)}
          aria-label={label}
          aria-pressed={state.active.includes(format)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)}
        >
          {symbol}
        </button>
      ))}
      <button
        type="button"
        {...rovingProps(FORMATS.length)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onEditLink}
      >
        Link
      </button>
    </div>
  );
}
