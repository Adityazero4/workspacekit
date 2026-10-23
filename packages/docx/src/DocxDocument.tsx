'use client';
import { partProps, viewerError, type RendererProps, type ViewerError } from '@scope/react/renderer-kit';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DocxLoading } from './DocxViewer';
import type { DocxClassNames } from './parts';
import { followBookmark, renderDocx, showRendered } from './renderDocx';
import { DocumentLimitExceeded, EncryptedDocument } from './limits';

/**
 * Props of `DocxDocument`.
 *
 * @example
 * ```tsx
 * const props: DocxDocumentProps = { data, name: 'report.docx', classNames: undefined, onError: report };
 * ```
 */
export interface DocxDocumentProps {
  data: ArrayBuffer;
  name: string;
  classNames: DocxClassNames | undefined;
  onError: (error: ViewerError) => void;
}

function errorOf(thrown: unknown): ViewerError {
  if (thrown instanceof EncryptedDocument) return viewerError('password_protected', thrown);
  return viewerError(thrown instanceof DocumentLimitExceeded ? 'too_large' : 'load_error', thrown);
}

const shadowRootOf = (host: HTMLElement): ShadowRoot =>
  host.shadowRoot ?? host.attachShadow({ mode: 'open' });

/**
 * One `.docx`, rendered from an effect (never during React's commit) into the shadow root of the
 * `docx-document` part, so the document's styles and ids stay inside it. A new `data` replaces the shown
 * document once it has rendered (it is busy until then, or until that version fails); a render overtaken by a
 * newer `data`, or by unmount, is never mounted.
 * Unmount empties the shadow root.
 *
 * @example
 * ```tsx
 * <DocxDocument data={buffer} name="report.docx" classNames={undefined} onError={report} />
 * ```
 */
export default function DocxDocument(props: DocxDocumentProps): React.JSX.Element {
  'use no memo';
  const { data, name, classNames } = props;
  const host = useRef<HTMLDivElement>(null);
  const [shownData, setShownData] = useState<ArrayBuffer>();
  const [settledData, setSettledData] = useState<ArrayBuffer>();
  const reportError = useEffectEvent((thrown: unknown) => props.onError(errorOf(thrown)));

  useEffect(() => {
    const shadowRoot = shadowRootOf(host.current!);
    const onClick = (event: Event): void => followBookmark(event, shadowRoot);
    shadowRoot.addEventListener('click', onClick);
    return () => {
      shadowRoot.removeEventListener('click', onClick);
      showRendered(shadowRoot, null);
    };
  }, []);

  useEffect(() => {
    const shadowRoot = shadowRootOf(host.current!);
    const controller = new AbortController();
    renderDocx(data, controller.signal).then(
      (rendered) => {
        if (controller.signal.aborted) return;
        showRendered(shadowRoot, rendered);
        setShownData(data);
        setSettledData(data);
      },
      (thrown: unknown) => {
        if (controller.signal.aborted) return;
        setSettledData(data);
        reportError(thrown);
      },
    );
    return () => controller.abort();
  }, [data]);

  return (
    <>
      {shownData === undefined && <DocxLoading name={name} classNames={classNames} />}
      <div
        ref={host}
        {...partProps('docx-document', classNames)}
        role="region"
        aria-label={`Contents of ${name}`}
        aria-busy={settledData !== data || undefined}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must be focusable to be scrolled by keyboard
        tabIndex={0}
      />
    </>
  );
}

/**
 * Props of `DocxRenderer`: the registry's renderer props, with this package's `classNames`.
 *
 * @example
 * ```tsx
 * const props: DocxRendererProps = { ...rendererProps, classNames: { 'docx-viewer': 'viewer' } };
 * ```
 */
export interface DocxRendererProps extends Omit<RendererProps, 'classNames'> {
  classNames?: DocxClassNames;
}

/**
 * The registry's component for `.docx` files: the `docx-viewer` root around `DocxDocument`. A failure goes
 * to the viewer's `onError`, which keeps an earlier version on screen under a banner.
 *
 * @example
 * ```tsx
 * <DocxRenderer {...rendererProps} classNames={{ 'docx-document': 'page' }} />
 * ```
 */
export function DocxRenderer(props: DocxRendererProps): React.JSX.Element {
  'use no memo';
  const { entry, source, onError, className, classNames } = props;
  return (
    <div {...partProps('docx-viewer', classNames, className)}>
      {source.kind === 'arrayBuffer' && (
        <DocxDocument data={source.data} name={entry.name} classNames={classNames} onError={onError} />
      )}
    </div>
  );
}
