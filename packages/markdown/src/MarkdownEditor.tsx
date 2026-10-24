'use client';
import { StandaloneRoot, type StandaloneViewerProps } from '@workspacekit/react/renderer-kit';
import { TextViewer } from '@workspacekit/react/renderers';
import type { ComponentType } from 'react';
import { MarkdownBody, type MarkdownMode } from './MarkdownView';
import type { MarkdownPart } from './parts';

const SHOWN = { status: 'ready' } as const;
const NO_BYTES = new Uint8Array();

/**
 * Props of the editor `MarkdownEditor` uses for source mode. `CodeEditor` from `@workspacekit/code` takes
 * them.
 *
 * @example
 * ```tsx
 * const Plain = (props: SourceEditorProps) => <textarea value={props.value} readOnly />;
 * ```
 */
export interface SourceEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  fileName?: string;
}

/**
 * Props of `MarkdownEditor`: a controlled `value`, with every standalone viewer prop except `src`.
 * `onChange` receives the whole text after an edit; `mode` picks the `rendered` (default) or `source`
 * view; `sourceEditor` draws source mode (the light text editor by default; pass `CodeEditor` from
 * `@workspacekit/code` for highlighting).
 *
 * @example
 * ```tsx
 * const props: MarkdownEditorProps = { value: '# Notes', fileName: 'notes.md', onChange: setNotes };
 * ```
 */
export interface MarkdownEditorProps extends Omit<StandaloneViewerProps<MarkdownPart>, 'src'> {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  mode?: MarkdownMode;
  sourceEditor?: ComponentType<SourceEditorProps>;
}

function TextSourceEditor(props: SourceEditorProps): React.JSX.Element {
  return <TextViewer src={NO_BYTES} {...props} />;
}

/**
 * A Markdown editor without a `FileSystemProvider`: the same WYSIWYG view as the registry entry (Lexical,
 * loaded on first render), labelled "Contents of <fileName>" (or "File contents"), with the slash menu,
 * the format toolbar (Alt+F10) and the Cmd/Ctrl+K link editor. A new `value` replaces the document unless
 * the user has edits not yet reported (reports follow a 300 ms pause, or blur); a new `fileName` starts a
 * fresh editor. A value over 500,000 characters, or one too complex to render, is shown in the source
 * editor.
 *
 * @example
 * ```tsx
 * const [notes, setNotes] = useState('# Notes');
 * <MarkdownEditor value={notes} onChange={setNotes} fileName="notes.md" />;
 * ```
 */
export function MarkdownEditor(props: MarkdownEditorProps): React.JSX.Element {
  const { value, onChange, readOnly = false, mode = 'rendered', fileName, classNames } = props;
  const SourceEditor = props.sourceEditor ?? TextSourceEditor;
  return (
    <StandaloneRoot part="md-viewer" errorPart="md-error" state={SHOWN} viewer={props}>
      <MarkdownBody
        key={fileName}
        text={value}
        name={fileName ?? 'Markdown document'}
        label={fileName === undefined ? 'File contents' : `Contents of ${fileName}`}
        readOnly={readOnly}
        onChange={onChange}
        mode={mode}
        source={() => (
          <SourceEditor value={value} onChange={onChange} readOnly={readOnly} fileName={fileName} />
        )}
        classNames={classNames}
      />
    </StandaloneRoot>
  );
}
