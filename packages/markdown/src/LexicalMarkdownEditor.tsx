'use client';
import { partProps } from '@scope/react/renderer-kit';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { allowedLinkUrl, registerSafeLinks } from './links';
import type { MarkdownClassNames } from './parts';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { LinkEditor, linkEditorFor, registerLinkShortcut, type LinkTarget } from './plugins/LinkEditorPlugin';
import { SlashMenuPlugin } from './plugins/SlashMenuPlugin';
import { createMarkdownSync, type MarkdownSync } from './sync';
import { MARKDOWN_NODES, MARKDOWN_TRANSFORMERS } from './transformers';
import { GFM_TABLE } from './transformers/table';
import { PARAGRAPH_ESCAPES } from './transformers/paragraph';
import { SETEXT_HEADING } from './transformers/rule';

const SHORTCUT_TRANSFORMERS = MARKDOWN_TRANSFORMERS.filter(
  (transformer) =>
    transformer !== GFM_TABLE && transformer !== PARAGRAPH_ESCAPES && transformer !== SETEXT_HEADING,
);

const THEME: InitialConfigType['theme'] = {
  text: { strikethrough: 'fs-md-strikethrough', underline: 'fs-md-underline' },
  code: 'fs-md-code-block',
  list: { listitemChecked: 'fs-md-checked', listitemUnchecked: 'fs-md-unchecked' },
};

const rethrow = (error: Error): never => {
  throw error;
};

/**
 * Props of the Lexical editor: the whole Markdown `text` (frontmatter and any line breaks included), its
 * accessible `label`, `readOnly`, `onChange`, which receives the whole text after an edit, and
 * `onImportFailed`, called when the engine throws while reading a text (such as a stack overflow on a
 * pathological nesting), so the caller can show the source instead.
 *
 * @example
 * ```tsx
 * const props: LexicalMarkdownEditorProps = { text: '# A', label: 'a.md', readOnly: false, onImportFailed };
 * ```
 */
export interface LexicalMarkdownEditorProps {
  text: string;
  label: string;
  readOnly: boolean;
  onChange?: (text: string) => void;
  onImportFailed: () => void;
  classNames?: MarkdownClassNames;
}

function ReformatNotice(props: {
  onDismiss: () => void;
  classNames?: MarkdownClassNames;
}): React.JSX.Element {
  return (
    <div role="status" {...partProps('md-notice', props.classNames)}>
      <span>
        Saving rewrites this file&apos;s Markdown in a standard form; some spacing and markers may change. Use
        Source mode to keep the exact text.
      </span>
      <button type="button" onClick={props.onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function receiveOrGiveUp(sync: MarkdownSync, props: LexicalMarkdownEditorProps): void {
  try {
    sync.receive(props.text);
  } catch {
    props.onImportFailed();
  }
}

function SyncPlugin(
  props: LexicalMarkdownEditorProps & { container: HTMLElement; onReformat: () => void },
): null {
  const { text, readOnly, container } = props;
  const [editor] = useLexicalComposerContext();
  const sync = useRef<MarkdownSync | null>(null);
  const currentDeliver = useEffectEvent(() => props.onChange);
  const announceReformat = useEffectEvent(() => props.onReformat());
  const receiveCurrentText = useEffectEvent((target: MarkdownSync) => receiveOrGiveUp(target, props));
  useEffect(() => {
    const created = createMarkdownSync(editor, {
      currentDeliver: () => currentDeliver(),
      onReformat: () => announceReformat(),
    });
    sync.current = created;
    const stopWatching = created.watch(container);
    const stopListening = created.listen();
    receiveCurrentText(created);
    return () => {
      stopWatching();
      stopListening();
      sync.current = null;
    };
  }, [editor, container]);
  useEffect(() => registerSafeLinks(editor), [editor]);
  useEffect(() => {
    if (sync.current) receiveCurrentText(sync.current);
  }, [text]);
  useEffect(() => editor.setEditable(!readOnly), [editor, readOnly]);
  return null;
}

function Tools(props: { container: HTMLElement; classNames?: MarkdownClassNames }): React.JSX.Element {
  const { container, classNames } = props;
  const [editor] = useLexicalComposerContext();
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const openLinkEditor = (): void =>
    setLinkTarget(editor.getEditorState().read(() => linkEditorFor(container)));
  const openFromShortcut = useEffectEvent(openLinkEditor);
  useEffect(() => registerLinkShortcut(editor, () => openFromShortcut()), [editor]);
  return (
    <>
      <SlashMenuPlugin container={container} classNames={classNames} />
      <FloatingToolbarPlugin container={container} onEditLink={openLinkEditor} classNames={classNames} />
      {linkTarget && (
        <LinkEditor target={linkTarget} onClose={() => setLinkTarget(null)} classNames={classNames} />
      )}
    </>
  );
}

/**
 * The rendered Markdown editor: Lexical with rich text, history, lists and check lists, links, tables and
 * Markdown shortcuts, plus the slash menu, the floating format toolbar and the Cmd/Ctrl+K link editor. It
 * keeps `text` and `onChange` in step through `createMarkdownSync`, shows the one-time "may reformat"
 * notice the first time an edit would rewrite the file's Markdown, and draws links safely. Loaded lazily.
 *
 * @example
 * ```tsx
 * const LexicalMarkdownEditor = lazy(() => import('./LexicalMarkdownEditor'));
 * <LexicalMarkdownEditor text={text} label="Contents of a.md" readOnly={false} onChange={save} />;
 * ```
 */
export default function LexicalMarkdownEditor(props: LexicalMarkdownEditorProps): React.JSX.Element {
  const { label, readOnly, classNames } = props;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [isNoticeShown, setNoticeShown] = useState(false);
  const initialConfig: InitialConfigType = {
    namespace: 'fs-markdown',
    nodes: MARKDOWN_NODES,
    theme: THEME,
    editable: !readOnly,
    onError: rethrow,
  };
  return (
    <LexicalComposer initialConfig={initialConfig}>
      {isNoticeShown && <ReformatNotice onDismiss={() => setNoticeShown(false)} classNames={classNames} />}
      <div ref={setContainer} {...partProps('md-editor', classNames)}>
        <RichTextPlugin
          contentEditable={<ContentEditable aria-label={label} aria-multiline tabIndex={0} />}
          ErrorBoundary={LexicalErrorBoundary}
        />
        {container && <Tools container={container} classNames={classNames} />}
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />
      <LinkPlugin validateUrl={(url) => allowedLinkUrl(url) !== null} />
      <TablePlugin />
      <MarkdownShortcutPlugin transformers={SHORTCUT_TRANSFORMERS} />
      {container && <SyncPlugin {...props} container={container} onReformat={() => setNoticeShown(true)} />}
    </LexicalComposer>
  );
}
