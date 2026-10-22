'use client';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import type { RendererProps } from '../../viewer/registry';
import { useStandaloneText } from '../standalone';
import { StandaloneRoot } from '../StandaloneRoot';
import TextRenderer, { TextViewer, type TextViewerProps } from '../text/TextViewer';

/**
 * Props of the standalone `HtmlViewer`: `TextViewer`'s, plus `mode`. `'preview'` (the default) renders the
 * page in a sandboxed frame; `'source'` shows it in `TextViewer`, where `value`, `onChange` and `readOnly`
 * apply.
 *
 * @example
 * ```tsx
 * const props: HtmlViewerProps = { src: '/report.html', fileName: 'report.html', mode: 'source' };
 * ```
 */
export interface HtmlViewerProps extends TextViewerProps {
  mode?: 'preview' | 'source';
}

const PREVIEW_POLICY_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
].join('; ');
const PREVIEW_POLICY = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY_DIRECTIVES}">`;

function HtmlPreview(props: {
  html: string;
  name: string;
  classNames: ClassNames | undefined;
}): React.JSX.Element {
  const { html, name, classNames } = props;
  if (html.trim() === '') {
    return <p {...partProps('html-empty', classNames)}>No content to preview</p>;
  }
  return (
    <iframe
      {...partProps('html-preview', classNames)}
      srcDoc={PREVIEW_POLICY + html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={`Preview of ${name}`}
    />
  );
}

function StandaloneHtmlPreview(props: HtmlViewerProps): React.JSX.Element {
  const { src, fileName, classNames, onError, value } = props;
  const { file, isLoadingNewSource } = useStandaloneText(src, onError);
  return (
    <StandaloneRoot
      part="html-viewer"
      errorPart="html-error"
      state={file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {file.status === 'ready' && (
        <HtmlPreview html={value ?? file.text} name={fileName ?? 'HTML document'} classNames={classNames} />
      )}
    </StandaloneRoot>
  );
}

/**
 * Shows an HTML file without a `FileSystemProvider`. In `'preview'` mode (the default) the page runs in an
 * `<iframe srcdoc>` sandboxed to `allow-scripts` only, so its scripts run in an opaque origin that cannot
 * reach the app. A Content-Security-Policy placed before the page's own content allows only inline scripts
 * and styles, `data:` and `blob:` images and `data:` fonts: the page cannot fetch, load remote resources or
 * submit forms. It can still navigate its own frame (a `<meta http-equiv="refresh">` or a script), which
 * stays sandboxed. An empty file shows "No content to preview". In `'source'` mode it is `TextViewer`. `src`
 * is a URL (fetched) or the file's bytes, decoded as UTF-8.
 *
 * @example
 * ```tsx
 * <HtmlViewer src={file} fileName={file.name} mode={showSource ? 'source' : 'preview'} />
 * ```
 */
export function HtmlViewer(props: HtmlViewerProps): React.JSX.Element {
  const { mode, ...textProps } = props;
  return mode === 'source' ? <TextViewer {...textProps} /> : <StandaloneHtmlPreview {...props} />;
}

/**
 * The HTML renderer component the registry loads. Its modes are `preview` (a sandboxed frame titled
 * "Preview of <name>", reloaded with each new version) and `source` (the text renderer, editable under the
 * same rules).
 *
 * @example
 * ```tsx
 * const { default: HtmlRenderer } = await htmlRenderer.load();
 * ```
 */
export default function HtmlRenderer(props: RendererProps): React.JSX.Element {
  const { entry, source, mode, className, classNames } = props;
  if (mode === 'source') return <TextRenderer {...props} />;
  return (
    <div {...partProps('html-viewer', classNames, className)}>
      <HtmlPreview
        html={source.kind === 'text' ? source.text : ''}
        name={entry.name}
        classNames={classNames}
      />
    </div>
  );
}
