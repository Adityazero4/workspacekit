'use client';
import {
  StandaloneRoot,
  useStandaloneBytes,
  type StandaloneViewerProps,
} from '@workspacekit/react/renderer-kit';
import { lazy, Suspense } from 'react';
import type { TemplatePart } from './parts';

const TemplateText = lazy(() => import('./TemplateText'));

/**
 * Shows a `.template` file without a `FileSystemProvider`. `src` is a URL or the file's bytes; the drawing
 * code (and, in a real package, its engine) loads on first render, so importing this component is cheap.
 *
 * @example
 * ```tsx
 * <TemplateViewer src={file} fileName={file.name} classNames={{ 'template-text': 'my-text' }} />
 * ```
 */
export function TemplateViewer(props: StandaloneViewerProps<TemplatePart>): React.JSX.Element {
  const { file, isLoadingNewSource } = useStandaloneBytes(props.src, props.onError);
  return (
    <StandaloneRoot
      part="template-viewer"
      errorPart="template-error"
      state={file}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
    >
      {file.status === 'ready' && (
        <Suspense fallback={null}>
          <TemplateText text={new TextDecoder().decode(file.data)} classNames={props.classNames} />
        </Suspense>
      )}
    </StandaloneRoot>
  );
}
