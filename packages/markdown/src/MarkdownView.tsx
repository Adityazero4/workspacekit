'use client';
import { partProps, type RendererProps } from '@scope/react/renderer-kit';
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import type { MarkdownClassNames } from './parts';
import { fitsTheRenderedView } from './renderedView';

const LexicalMarkdownEditor = lazy(() => import('./LexicalMarkdownEditor'));

/**
 * The view modes of the Markdown renderer: the WYSIWYG `rendered` view (the default) and `source`.
 *
 * @example
 * ```ts
 * const mode: MarkdownMode = 'source';
 * ```
 */
export type MarkdownMode = 'rendered' | 'source';

/**
 * Props of `MarkdownBody`: the Markdown `text`, the file's `name` (for the "Opening <name>…" status), the
 * editor's accessible `label`, `readOnly`, `onChange`, the `mode`, and `source`, which draws the source view.
 *
 * @example
 * ```tsx
 * const props: MarkdownBodyProps = {
 *   text,
 *   name: 'a.md',
 *   label: 'Contents of a.md',
 *   readOnly: false,
 *   mode: 'rendered',
 *   source,
 * };
 * ```
 */
export interface MarkdownBodyProps {
  text: string;
  name: string;
  label: string;
  readOnly: boolean;
  onChange?: (text: string) => void;
  mode: MarkdownMode;
  source: () => ReactNode;
  classNames?: MarkdownClassNames;
}

function Loading(props: { name: string; classNames?: MarkdownClassNames }): React.JSX.Element {
  return (
    <p {...partProps('md-loading', props.classNames)} role="status">
      Opening {props.name}…
    </p>
  );
}

/**
 * The rendered editor (loaded on first use) or, in `source` mode, the source view. A text that arrives from
 * outside and is over 500,000 characters, or whose import would be too much work (see
 * `fitsTheRenderedView`), is shown as source in either mode, with a notice saying why; so is a text the
 * editor failed to import. The editor's own edits are never gated, so typing past the budget does not
 * swap the editor out from under the user.
 *
 * @example
 * ```tsx
 * <MarkdownBody text={text} name="a.md" label="a.md" readOnly={false} mode="source" source={renderSource} />
 * ```
 */
export function MarkdownBody(props: MarkdownBodyProps): React.JSX.Element {
  const { text, name, label, readOnly, onChange, mode, source, classNames } = props;
  const [editorText, setEditorText] = useState<string | null>(null);
  const [hasFailed, setFailed] = useState(false);
  const fits = !hasFailed && (text === editorText || fitsTheRenderedView(text));
  const reportEdit =
    onChange &&
    ((edited: string): void => {
      setEditorText(edited);
      onChange(edited);
    });
  if (mode === 'source' || !fits) {
    return (
      <>
        {!fits && (
          <p role="status" {...partProps('md-notice', classNames)}>
            This file is too large or too complex for the rendered view, so it is shown as source.
          </p>
        )}
        <Suspense fallback={<Loading name={name} classNames={classNames} />}>{source()}</Suspense>
      </>
    );
  }
  return (
    <Suspense fallback={<Loading name={name} classNames={classNames} />}>
      <LexicalMarkdownEditor
        text={text}
        label={label}
        readOnly={readOnly}
        onChange={reportEdit}
        onImportFailed={() => setFailed(true)}
        classNames={classNames}
      />
    </Suspense>
  );
}

/**
 * Props of `MarkdownRendererView`: the viewer's renderer props, this package's `markdownClassNames` (from
 * `markdownRenderer({ classNames })`) and `Source`, the component of the renderer that draws source mode.
 *
 * @example
 * ```ts
 * const props: MarkdownRendererProps = { ...rendererProps, Source: TextRenderer };
 * ```
 */
export interface MarkdownRendererProps extends RendererProps {
  markdownClassNames?: MarkdownClassNames;
  Source: ComponentType<RendererProps>;
}

/**
 * The component `markdownRenderer()` loads for the viewer: an `md-viewer` root holding `MarkdownBody` for
 * the entry's text, labelled "Contents of <path>", in the viewer's mode. Source mode hands the same props
 * to the source renderer, so edits there flow through the viewer exactly as in the rendered view.
 *
 * @example
 * ```tsx
 * <MarkdownRendererView {...rendererProps} Source={TextRenderer} />
 * ```
 */
export function MarkdownRendererView(props: MarkdownRendererProps): React.JSX.Element {
  const { markdownClassNames, Source, ...rendererProps } = props;
  const { entry, source, readOnly, onChange, mode, className } = rendererProps;
  return (
    <div {...partProps('md-viewer', markdownClassNames, className)}>
      <MarkdownBody
        text={source.kind === 'text' ? source.text : ''}
        name={entry.name}
        label={`Contents of ${entry.path}`}
        readOnly={readOnly}
        onChange={onChange}
        mode={mode === 'source' ? 'source' : 'rendered'}
        source={() => <Source {...rendererProps} mode={undefined} />}
        classNames={markdownClassNames}
      />
    </div>
  );
}
