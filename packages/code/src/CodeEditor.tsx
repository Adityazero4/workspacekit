'use client';
import { partProps, StandaloneRoot, type StandaloneViewerProps } from '@workspacekit/react/renderer-kit';
import { lazy, Suspense } from 'react';
import type { CodeMirrorEditorProps } from './CodeMirrorEditor';
import type { CodePart } from './parts';

const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'));
const SHOWN = { status: 'ready' } as const;

/**
 * Props of `CodeEditor`: a controlled `value`, with every standalone viewer prop except `src`. `onChange`
 * receives the whole text after each edit; `language` (a name or alias such as `python`) overrides the one
 * picked from `fileName`; `nonce` is passed to the `<style>` elements CodeMirror adds, for a strict CSP.
 *
 * @example
 * ```tsx
 * const props: CodeEditorProps = { value: 'SELECT 1;', fileName: 'query.sql', onChange: setQuery };
 * ```
 */
export interface CodeEditorProps extends Omit<StandaloneViewerProps<CodePart>, 'src'> {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  nonce?: string;
}

/**
 * The CodeMirror editor, loaded on first render, labelled "Contents of <fileName>" (or "File contents"), and
 * started afresh for each `fileName`. While its code loads, a `code-loading` status says so. Shared by
 * `CodeEditor` and `CodeViewer`.
 *
 * @example
 * ```tsx
 * <LazyCodeMirrorEditor text={value} fileName="a.ts" readOnly={false} onChange={setValue} />
 * ```
 */
export function LazyCodeMirrorEditor(props: Omit<CodeMirrorEditorProps, 'label'>): React.JSX.Element {
  const { fileName, classNames } = props;
  const loading = `Opening ${fileName ?? 'the editor'}…`;
  return (
    <Suspense
      fallback={
        <p {...partProps('code-loading', classNames)} role="status">
          {loading}
        </p>
      }
    >
      <CodeMirrorEditor
        key={fileName}
        {...props}
        label={fileName === undefined ? 'File contents' : `Contents of ${fileName}`}
      />
    </Suspense>
  );
}

/**
 * A code editor without a `FileSystemProvider`: CodeMirror 6 with syntax highlighting for `fileName` (or
 * `language`), themed by the `--fs-*` tokens. CodeMirror loads on first render, so importing this is cheap.
 * A new `value` replaces the text in place, keeping the selection and scroll, unless the user has typed
 * since the previous `value`: between an edit and the parent's echo of it, the editor is the source of
 * truth, so a parent's late echo never undoes typing, and a parent cannot rewrite the text it has just
 * received (an echo that differs from what was typed is ignored; a later, different `value` applies). Edits
 * keep the text's line endings. Tab moves focus out of the editor; a new `fileName` starts a fresh editor.
 *
 * @example
 * ```tsx
 * const [query, setQuery] = useState('SELECT 1;');
 * <CodeEditor value={query} onChange={setQuery} fileName="query.sql" />;
 * ```
 */
export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const { value, onChange, fileName, language, readOnly, nonce, classNames } = props;
  return (
    <StandaloneRoot part="code-viewer" errorPart="code-error" state={SHOWN} viewer={props}>
      <LazyCodeMirrorEditor
        text={value}
        fileName={fileName}
        language={language}
        readOnly={readOnly ?? false}
        onChange={onChange}
        nonce={nonce}
        classNames={classNames}
      />
    </StandaloneRoot>
  );
}
