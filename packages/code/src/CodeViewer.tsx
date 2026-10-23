'use client';
import { StandaloneRoot, useStandaloneBytes, type StandaloneViewerProps } from '@scope/react/renderer-kit';
import { LazyCodeMirrorEditor } from './CodeEditor';
import { CODE_MAX_BYTES } from './codeRenderer';
import type { CodePart } from './parts';

/**
 * Props of `CodeViewer`: the standalone viewer props, plus `language` (a name or alias such as `python`,
 * overriding the one picked from `fileName`) and `nonce` for CodeMirror's `<style>` elements under a strict
 * CSP.
 *
 * @example
 * ```tsx
 * const props: CodeViewerProps = { src: '/config.yaml', fileName: 'config.yaml', theme: 'dark' };
 * ```
 */
export interface CodeViewerProps extends StandaloneViewerProps<CodePart> {
  language?: string;
  nonce?: string;
}

/**
 * Shows a code file read-only without a `FileSystemProvider`. `src` is a URL (fetched) or the file's bytes,
 * decoded as UTF-8; the text can be selected and copied. CodeMirror loads on first render. A file over
 * 10 MiB is `too_large` and is not read (a URL is refused by its `Content-Length` before its body is read).
 *
 * @example
 * ```tsx
 * <CodeViewer src={file} fileName={file.name} />
 * ```
 */
export function CodeViewer(props: CodeViewerProps): React.JSX.Element {
  const { fileName, language, nonce, classNames } = props;
  const { file, isLoadingNewSource } = useStandaloneBytes(props.src, props.onError, {
    maxBytes: CODE_MAX_BYTES,
  });
  return (
    <StandaloneRoot
      part="code-viewer"
      errorPart="code-error"
      state={file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {file.status === 'ready' && (
        <LazyCodeMirrorEditor
          text={new TextDecoder().decode(file.data)}
          fileName={fileName}
          language={language}
          readOnly
          nonce={nonce}
          classNames={classNames}
        />
      )}
    </StandaloneRoot>
  );
}
