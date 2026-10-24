'use client';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput, type LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Transaction, type Extension, type Text } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import {
  lineBreakOf,
  partProps,
  withLfLineBreaks,
  type RendererProps,
} from '@workspacekit/react/renderer-kit';
import { useEffect, useEffectEvent, useRef } from 'react';
import { editReporter } from './editReporter';
import { matchFilename, matchLanguageName } from './languages';
import type { CodeClassNames } from './parts';
import { applyRemoteUpdate } from './remoteUpdate';
import { codeTheme } from './theme';

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Props of `CodeMirrorEditor`. `text` is the source to show; `fileName` (or `language`, a language name or
 * alias, which wins) picks the highlighting; `label` is the editor's accessible name. `onChange` may change
 * between renders: an edit goes to the `onChange` current when it was typed, even when a large document
 * reports it later, so a viewer's callback that records the version the edit was based on stays right.
 *
 * @example
 * ```tsx
 * const props: CodeMirrorEditorProps = { text: 'a = 1', label: 'Contents of a.py', readOnly: false };
 * ```
 */
export interface CodeMirrorEditorProps {
  text: string;
  label: string;
  readOnly: boolean;
  fileName?: string;
  language?: string;
  onChange?: (text: string) => void;
  nonce?: string;
  classNames?: CodeClassNames;
}

interface MountedEditor {
  view: EditorView;
  readOnly: Compartment;
  label: Compartment;
  language: Compartment;
  lastSource: string;
  reportPendingEdits: () => void;
}

interface EditorSetup {
  label: string;
  readOnly: boolean;
  nonce: string | undefined;
  compartments: Pick<MountedEditor, 'readOnly' | 'label' | 'language'>;
  onUpdate: (update: ViewUpdate) => void;
}

const readOnlyExtension = (readOnly: boolean): Extension =>
  readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];

const labelExtension = (label: string): Extension =>
  EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' });

const isUserEdit = (transaction: Transaction): boolean =>
  transaction.docChanged && transaction.annotation(Transaction.remote) !== true;

function editorExtensions(setup: EditorSetup): Extension[] {
  const { compartments } = setup;
  return [
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    drawSelection(prefersReducedMotion() ? { cursorBlinkRate: 0 } : {}),
    indentOnInput(),
    bracketMatching(),
    EditorState.tabSize.of(2),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    codeTheme,
    setup.nonce === undefined ? [] : EditorView.cspNonce.of(setup.nonce),
    compartments.readOnly.of(readOnlyExtension(setup.readOnly)),
    compartments.label.of(labelExtension(setup.label)),
    compartments.language.of([]),
    EditorView.updateListener.of(setup.onUpdate),
  ];
}

type DeliverEdit = (doc: Text) => void;

function mountEditor(
  parent: HTMLElement,
  props: CodeMirrorEditorProps,
  currentDelivery: () => DeliverEdit | undefined,
): MountedEditor {
  const source = withLfLineBreaks(props.text);
  const compartments = { readOnly: new Compartment(), label: new Compartment(), language: new Compartment() };
  const reporter = editReporter<Text>();
  const onUpdate = (update: ViewUpdate): void => {
    const deliver = update.transactions.some(isUserEdit) ? currentDelivery() : undefined;
    if (deliver) reporter.changed(update.state.doc, deliver);
    if (update.focusChanged && !update.view.hasFocus) reporter.flush();
  };
  const extensions = editorExtensions({
    label: props.label,
    readOnly: props.readOnly,
    nonce: props.nonce,
    compartments,
    onUpdate,
  });
  const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions }) });
  return { view, ...compartments, lastSource: source, reportPendingEdits: reporter.flush };
}

function reportPendingEditsWhenThePageHides(editor: MountedEditor): () => void {
  const reportIfHidden = (): void => {
    if (document.visibilityState === 'hidden') editor.reportPendingEdits();
  };
  window.addEventListener('pagehide', editor.reportPendingEdits, { capture: true });
  document.addEventListener('visibilitychange', reportIfHidden);
  return () => {
    window.removeEventListener('pagehide', editor.reportPendingEdits, { capture: true });
    document.removeEventListener('visibilitychange', reportIfHidden);
  };
}

function languageDescriptionFor(wanted: {
  fileName?: string;
  language?: string;
}): LanguageDescription | null {
  if (wanted.language !== undefined) return matchLanguageName(languages, wanted.language);
  return wanted.fileName === undefined ? null : matchFilename(languages, wanted.fileName);
}

function loadLanguage(editor: MountedEditor, wanted: { fileName?: string; language?: string }): () => void {
  let isCurrent = true;
  const show = (support: Extension): void => {
    if (isCurrent) editor.view.dispatch({ effects: editor.language.reconfigure(support) });
  };
  const description = languageDescriptionFor(wanted);
  if (description) void description.load().then(show, () => show([]));
  else show([]);
  return () => {
    isCurrent = false;
  };
}

/**
 * A CodeMirror 6 editor inside a `code-editor` part, kept in step with React props. Edits reach `onChange`
 * with the source's line endings (CRLF when its first line break is CRLF); documents over 1 MiB report
 * after a 300 ms pause, and at once on blur, on unmount, on `pagehide` (before the viewer's own `pagehide`
 * save) and when the tab becomes hidden. A new `text` is applied in place as a remote change (see
 * `applyRemoteUpdate`), never reported back, and dropped while the user has edits not yet reported. The
 * language loads lazily; a load that finishes after the file or language changed is dropped, and one that
 * fails (such as a chunk that can't be fetched) leaves the text plain, silently. Tab is left to the browser,
 * so it moves focus out; read-only stays focusable for selecting and copying. Under
 * `prefers-reduced-motion` the cursor does not blink.
 *
 * @example
 * ```tsx
 * const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'));
 * <CodeMirrorEditor text={text} label="Contents of a.ts" fileName="a.ts" readOnly={false} onChange={save} />;
 * ```
 */
export default function CodeMirrorEditor(props: CodeMirrorEditorProps): React.JSX.Element {
  'use no memo';
  const { text, label, readOnly, fileName, language, classNames } = props;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<MountedEditor | null>(null);
  const source = withLfLineBreaks(text);
  const currentDelivery = useEffectEvent((): DeliverEdit | undefined => {
    const { onChange } = props;
    const lineBreak = lineBreakOf(text);
    return onChange && ((doc) => onChange(doc.sliceString(0, doc.length, lineBreak)));
  });
  const mount = useEffectEvent((parent: HTMLElement) => mountEditor(parent, props, () => currentDelivery()));
  useEffect(() => {
    const mounted = mount(host.current!);
    editor.current = mounted;
    const stopWatchingThePage = reportPendingEditsWhenThePageHides(mounted);
    return () => {
      stopWatchingThePage();
      editor.current = null;
      mounted.reportPendingEdits();
      mounted.view.destroy();
    };
  }, []);
  useEffect(() => {
    const mounted = editor.current;
    if (!mounted) return;
    const previous = mounted.lastSource;
    mounted.lastSource = source;
    applyRemoteUpdate(mounted.view, { previous, next: source });
  }, [source]);
  useEffect(() => {
    const mounted = editor.current;
    mounted?.view.dispatch({ effects: mounted.readOnly.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);
  useEffect(() => {
    const mounted = editor.current;
    mounted?.view.dispatch({ effects: mounted.label.reconfigure(labelExtension(label)) });
  }, [label]);
  useEffect(() => {
    if (!editor.current) return;
    return loadLanguage(editor.current, { fileName, language });
  }, [fileName, language]);
  return <div ref={host} {...partProps('code-editor', classNames)} />;
}

/**
 * Props of `CodeRenderer`: the viewer's renderer props, with `classNames` for this package's parts (from
 * `codeRenderer({ classNames })`) in place of the viewer's, and the CSP `nonce`.
 *
 * @example
 * ```ts
 * const props: CodeRendererProps = { ...rendererProps, classNames: { 'code-editor': 'my-editor' } };
 * ```
 */
export interface CodeRendererProps extends Omit<RendererProps, 'classNames'> {
  classNames?: CodeClassNames;
  nonce?: string;
}

/**
 * The component `codeRenderer()` loads for the viewer: the editor for a `text` source, labelled "Contents of
 * <path>", highlighted by the entry's name. A rename or move keeps the editor (and its undo history) and
 * re-picks the language.
 *
 * @example
 * ```tsx
 * <CodeRenderer {...rendererProps} classNames={{ 'code-editor': 'my-editor' }} nonce={nonce} />
 * ```
 */
export function CodeRenderer(props: CodeRendererProps): React.JSX.Element {
  const { entry, source, readOnly, onChange, nonce, className, classNames } = props;
  return (
    <div {...partProps('code-viewer', classNames, className)}>
      <CodeMirrorEditor
        text={source.kind === 'text' ? source.text : ''}
        label={`Contents of ${entry.path}`}
        fileName={entry.name}
        readOnly={readOnly}
        onChange={onChange}
        nonce={nonce}
        classNames={classNames}
      />
    </div>
  );
}
