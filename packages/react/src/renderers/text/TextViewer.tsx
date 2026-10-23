'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import type { RendererProps } from '../../viewer/registry';
import { useStandaloneText, type StandaloneViewerProps } from '../standalone';
import { StandaloneRoot } from '../StandaloneRoot';
import { useLatest } from '../useLatest';
import { lineBreakOf, withLfLineBreaks, withLineBreak } from '../lineBreaks';
import { LineView } from './LineView';

const EDITABLE_MAX_BYTES = 1024 * 1024;
const TEXT_RENDERER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Props of the standalone `TextViewer`. `value`, when set, is the text shown instead of the loaded file (a
 * controlled editor: a new `value` always replaces the text, keeping scroll and selection); `onChange`
 * receives the whole text on every edit.
 *
 * @example
 * ```tsx
 * const props: TextViewerProps = { src: '/notes.txt', fileName: 'notes.txt', readOnly: true };
 * ```
 */
export interface TextViewerProps extends StandaloneViewerProps {
  value?: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
}

interface TextBodyProps {
  text: string;
  isControlled: boolean;
  holdEdits: boolean;
  byteSize: number;
  label: string;
  readOnly: boolean;
  onChange: ((text: string) => void) | undefined;
  classNames: ClassNames | undefined;
}

function replaceKeepingScrollAndSelection(editor: HTMLTextAreaElement, text: string): number {
  const { scrollTop, scrollLeft, selectionStart, selectionEnd, selectionDirection } = editor;
  const restoreScroll = (): void => {
    editor.scrollTop = scrollTop;
    editor.scrollLeft = scrollLeft;
  };
  editor.value = text;
  editor.setSelectionRange(
    Math.min(selectionStart, text.length),
    Math.min(selectionEnd, text.length),
    selectionDirection ?? undefined,
  );
  restoreScroll();
  const frameAfterFirefoxScrollsTheSelectionIntoView = requestAnimationFrame(restoreScroll);
  return frameAfterFirefoxScrollsTheSelectionIntoView;
}

interface SourceSync {
  textarea: HTMLTextAreaElement;
  editorText: string;
  isControlled: boolean;
  textFromSource: { current: string };
  editedWhileHeld: { current: boolean };
  onLocalEditsChange: (hasLocalEdits: boolean) => void;
  reportEdit: (typed: string) => void;
}

function settleEditsMadeWhileHeld(sync: SourceSync): number | undefined {
  const { textarea, editorText, textFromSource } = sync;
  sync.editedWhileHeld.current = false;
  if (editorText === textFromSource.current) {
    sync.reportEdit(textarea.value);
    return undefined;
  }
  textFromSource.current = editorText;
  sync.onLocalEditsChange(false);
  return replaceKeepingScrollAndSelection(textarea, editorText);
}

function syncWithSource(sync: SourceSync): number | undefined {
  const { textarea, editorText, isControlled, textFromSource } = sync;
  if (sync.editedWhileHeld.current) return settleEditsMadeWhileHeld(sync);
  if (editorText === textFromSource.current) return undefined;
  const hasLocalEdits = !isControlled && textarea.value !== textFromSource.current;
  textFromSource.current = editorText;
  sync.onLocalEditsChange(!isControlled && textarea.value !== editorText);
  if (hasLocalEdits || textarea.value === editorText) return undefined;
  return replaceKeepingScrollAndSelection(textarea, editorText);
}

interface TextEditorProps extends Omit<TextBodyProps, 'byteSize'> {
  onLocalEditsChange: (hasLocalEdits: boolean) => void;
}

function TextEditor(props: TextEditorProps): React.JSX.Element {
  const { text, isControlled, holdEdits, label, readOnly, onLocalEditsChange, classNames } = props;
  const editorText = withLfLineBreaks(text);
  const lineBreak = lineBreakOf(text);
  const [initialText] = useState(editorText);
  const editor = useRef<HTMLTextAreaElement>(null);
  const textFromSource = useRef(editorText);
  const editedWhileHeld = useRef(false);
  const onChange = useLatest(props.onChange);
  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea || holdEdits) return;
    const reportEdit = (typed: string): void => {
      onLocalEditsChange(!isControlled && typed !== textFromSource.current);
      onChange.current?.(withLineBreak(typed, lineBreak));
    };
    const sync = { textarea, editorText, isControlled, textFromSource, editedWhileHeld, onLocalEditsChange };
    const scrollRestoreFrame = syncWithSource({ ...sync, reportEdit });
    return () => {
      if (scrollRestoreFrame !== undefined) cancelAnimationFrame(scrollRestoreFrame);
    };
  }, [editorText, isControlled, holdEdits, lineBreak, onChange, onLocalEditsChange]);
  return (
    <textarea
      ref={editor}
      {...partProps('text-editor', classNames)}
      aria-label={label}
      defaultValue={initialText}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => {
        const typed = event.target.value;
        if (holdEdits) {
          editedWhileHeld.current = true;
          return;
        }
        onLocalEditsChange(!isControlled && typed !== textFromSource.current);
        onChange.current?.(withLineBreak(typed, lineBreak));
      }}
    />
  );
}

function TextBody(props: TextBodyProps): React.JSX.Element {
  const { byteSize, ...editorProps } = props;
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  if (byteSize > EDITABLE_MAX_BYTES && !hasLocalEdits) {
    return <LineView text={props.text} label={props.label} classNames={props.classNames} />;
  }
  return <TextEditor {...editorProps} onLocalEditsChange={setHasLocalEdits} />;
}

/**
 * Shows a text file without a `FileSystemProvider`: an editable `<textarea>` (labelled "Contents of
 * <fileName>") up to 1 MiB, a read-only virtualized line view above that. `src` is a URL, fetched with
 * `fetch`, or the file's bytes, decoded as UTF-8. When the loaded text changes and the user has not edited
 * it, the new text replaces it in place, keeping the scroll position and the selection; a new `fileName`
 * starts a fresh editor. While a new `src` loads, the previous text stays and the root is `aria-busy`; no
 * edit is reported for the wrong file: a URL being fetched makes the editor read-only, and an edit made
 * while bytes are decoded is reported only if the new file has the same text (otherwise the editor shows
 * the new file). Edits keep the file's line endings: when its first line break is CRLF, `onChange`
 * receives CRLF text. A file that grows past 1 MiB while edited stays in the editor. A file over 10 MiB (the
 * text renderer's limit) is `too_large` and is not read.
 *
 * @example
 * ```tsx
 * <TextViewer src={file} fileName={file.name} onChange={(text) => setDraft(text)} />
 * ```
 */
export function TextViewer(props: TextViewerProps): React.JSX.Element {
  const { src, fileName, classNames, onError, value, onChange } = props;
  const { file, isLoadingNewSource } = useStandaloneText(src, onError, { maxBytes: TEXT_RENDERER_MAX_BYTES });
  return (
    <StandaloneRoot
      part="text-viewer"
      errorPart="text-error"
      state={file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {file.status === 'ready' && (
        <TextBody
          key={fileName}
          text={value ?? file.text}
          isControlled={value !== undefined}
          holdEdits={isLoadingNewSource}
          byteSize={file.byteSize}
          label={fileName === undefined ? 'File contents' : `Contents of ${fileName}`}
          readOnly={(props.readOnly ?? false) || (isLoadingNewSource && typeof src === 'string')}
          onChange={onChange}
          classNames={classNames}
        />
      )}
    </StandaloneRoot>
  );
}

/**
 * The text renderer component the registry loads: `TextViewer`'s body for a viewer's `text` source,
 * labelled "Contents of <path>". The file's `size` (or, when unknown, the text's length) picks the editor
 * or the line view; an editor with local edits stays one. Edits keep the file's line endings.
 *
 * @example
 * ```tsx
 * const { default: TextRenderer } = await textRenderer.load();
 * ```
 */
export default function TextRenderer(props: RendererProps): React.JSX.Element {
  const { entry, source, readOnly, onChange, className, classNames } = props;
  const text = source.kind === 'text' ? source.text : '';
  return (
    <div {...partProps('text-viewer', classNames, className)}>
      <TextBody
        text={text}
        isControlled={false}
        holdEdits={false}
        byteSize={typeof entry.size === 'number' ? entry.size : text.length}
        label={`Contents of ${entry.path}`}
        readOnly={readOnly}
        onChange={onChange}
        classNames={classNames}
      />
    </div>
  );
}
