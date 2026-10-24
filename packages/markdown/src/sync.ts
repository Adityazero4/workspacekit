import { lineBreakOf, withLfLineBreaks, withLineBreak } from '@workspacekit/react/renderer-kit';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  CLEAR_HISTORY_COMMAND,
  HISTORY_MERGE_TAG,
  type EditorState,
  type LexicalEditor,
} from 'lexical';
import { joinDocument, splitDocument, type DocumentParts } from './frontmatter';
import { $exportMarkdown, $importMarkdown } from './transformers';

/**
 * The update tag on every change that came from outside the editor (the file's text as opened, or a newer
 * version written by someone else). Such updates are never reported back through `onChange`.
 *
 * @example
 * ```ts
 * editor.registerUpdateListener(({ tags }) => tags.has(REMOTE_UPDATE_TAG));
 * ```
 */
export const REMOTE_UPDATE_TAG = 'fs-markdown-remote-update';

const QUIET_MS = 300;
const LONGEST_WAIT_MS = 1000;
const USER_INPUT_EVENTS = ['keydown', 'beforeinput', 'paste', 'drop', 'cut', 'pointerdown'] as const;

type Deliver = (text: string) => void;

interface Received {
  text: string;
  parts: DocumentParts;
  lineBreak: ReturnType<typeof lineBreakOf>;
  state: EditorState;
  exportedBody: string | null;
}

interface Caret {
  block: number;
  offset: number;
}

function $caretPosition(): Caret | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const anchor = selection.anchor.getNode();
  const block = anchor.getTopLevelElement();
  if (block === null) return null;
  if (selection.anchor.type !== 'text') return { block: block.getIndexWithinParent(), offset: 0 };
  let offset = selection.anchor.offset;
  for (const text of block.getAllTextNodes()) {
    if (text.is(anchor)) break;
    offset += text.getTextContentSize();
  }
  return { block: block.getIndexWithinParent(), offset };
}

function $placeCaret(caret: Caret): void {
  const root = $getRoot();
  const block = root.getChildAtIndex(Math.min(caret.block, root.getChildrenSize() - 1));
  if (!$isElementNode(block)) return;
  let remaining = caret.offset;
  for (const text of block.getAllTextNodes()) {
    const size = text.getTextContentSize();
    if (remaining <= size) return void text.select(remaining, remaining);
    remaining -= size;
  }
  block.selectEnd();
}

/**
 * What the editor reports and receives, and when. Built by `createMarkdownSync`.
 *
 * @example
 * ```ts
 * const sync: MarkdownSync = createMarkdownSync(editor, hooks);
 * ```
 */
export interface MarkdownSync {
  receive: (text: string) => void;
  flush: () => void;
  watch: (container: HTMLElement) => () => void;
  listen: () => () => void;
}

/**
 * Hooks `createMarkdownSync` calls: `currentDeliver` returns the `onChange` current now (an edit goes to the
 * one current at its first keystroke, so a callback bound to the version the edit was based on stays
 * right), and `onReformat` runs once, the first time an edit is reported for a document whose Markdown the
 * editor writes differently from how it was read.
 *
 * @example
 * ```ts
 * const hooks: SyncHooks = { currentDeliver: () => onChange, onReformat: () => setNotice(true) };
 * ```
 */
export interface SyncHooks {
  currentDeliver: () => Deliver | undefined;
  onReformat: () => void;
}

interface SyncState {
  received: Received | null;
  lastKnown: string | null;
  pending: { deliver: Deliver; since: number } | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  userHasInteracted: boolean;
  reformatAnnounced: boolean;
  scroller: HTMLElement | null;
}

function textToReport(received: Received, body: string): string {
  received.exportedBody ??= received.state.read($exportMarkdown);
  if (body === received.exportedBody) return received.text;
  return withLineBreak(joinDocument({ ...received.parts, body }), received.lineBreak);
}

function flushPending(editor: LexicalEditor, state: SyncState, hooks: SyncHooks): void {
  clearTimeout(state.timer);
  state.timer = undefined;
  const { pending, received } = state;
  state.pending = null;
  if (pending === null || received === null) return;
  const next = textToReport(received, editor.getEditorState().read($exportMarkdown));
  if (next === state.lastKnown) return;
  state.lastKnown = next;
  if (!state.reformatAnnounced && next !== received.text && received.exportedBody !== received.parts.body) {
    state.reformatAnnounced = true;
    hooks.onReformat();
  }
  pending.deliver(next);
}

function receiveText(editor: LexicalEditor, state: SyncState, text: string): void {
  if (text === state.lastKnown || state.pending !== null) return;
  state.lastKnown = text;
  const parts = splitDocument(withLfLineBreaks(text));
  const scrollTop = state.scroller?.scrollTop ?? 0;
  editor.update(
    () => {
      const caret = $caretPosition();
      $importMarkdown(parts.body);
      if (caret) $placeCaret(caret);
    },
    { tag: [REMOTE_UPDATE_TAG, HISTORY_MERGE_TAG], discrete: true },
  );
  editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  if (state.scroller) state.scroller.scrollTop = scrollTop;
  state.received = {
    text,
    parts,
    lineBreak: lineBreakOf(text),
    state: editor.getEditorState(),
    exportedBody: null,
  };
}

function scheduleFlush(state: SyncState, hooks: SyncHooks, flush: () => void): void {
  if (state.pending === null) {
    const deliver = hooks.currentDeliver();
    if (deliver === undefined) return;
    state.pending = { deliver, since: Date.now() };
  }
  clearTimeout(state.timer);
  const untilTheLongestWait = state.pending.since + LONGEST_WAIT_MS - Date.now();
  state.timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, untilTheLongestWait)));
}

function watchContainer(state: SyncState, container: HTMLElement, flush: () => void): () => void {
  const markInteraction = (): void => void (state.userHasInteracted = true);
  const flushOnLeave = (event: FocusEvent): void => {
    if (!container.contains(event.relatedTarget as Node | null)) flush();
  };
  const flushIfHidden = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  state.scroller = container;
  for (const type of USER_INPUT_EVENTS) container.addEventListener(type, markInteraction, true);
  container.addEventListener('focusout', flushOnLeave);
  window.addEventListener('pagehide', flush, { capture: true });
  document.addEventListener('visibilitychange', flushIfHidden);
  return () => {
    for (const type of USER_INPUT_EVENTS) container.removeEventListener(type, markInteraction, true);
    container.removeEventListener('focusout', flushOnLeave);
    window.removeEventListener('pagehide', flush, { capture: true });
    document.removeEventListener('visibilitychange', flushIfHidden);
  };
}

/**
 * Keeps a Lexical editor and a Markdown text in step (Plan 3's edit contract):
 * - `receive(text)` shows a text that arrived from outside, tagged `REMOTE_UPDATE_TAG`, kept out of the
 *   undo history, keeping the scroll position and the caret's block and offset. It is ignored while the
 *   user has edits not yet reported, so a newer version never overwrites them: the edits are reported
 *   against the version they were based on and the viewer's conflict flow takes over.
 * - User edits (only after a keystroke, pointer, paste, cut or drop in `watch`'s container) are serialised
 *   300 ms after typing pauses, at most 1 s after the first edit, and at once on blur, `pagehide`, a
 *   hidden tab and when `listen`'s cleanup runs (unmount). Opening and closing a file serialises
 *   nothing. Frontmatter, the leading and trailing blank lines and CRLF line breaks are kept; a document
 *   edited back to its exported form reports the original text.
 *
 * @example
 * ```ts
 * const sync = createMarkdownSync(editor, { currentDeliver: () => onChange, onReformat });
 * useEffect(() => sync.listen(), [sync]);
 * useEffect(() => sync.receive(text), [sync, text]);
 * ```
 */
export function createMarkdownSync(editor: LexicalEditor, hooks: SyncHooks): MarkdownSync {
  const state: SyncState = {
    received: null,
    lastKnown: null,
    pending: null,
    timer: undefined,
    userHasInteracted: false,
    reformatAnnounced: false,
    scroller: null,
  };
  const flush = (): void => flushPending(editor, state, hooks);
  const listen = (): (() => void) => {
    const stopListening = editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
      const isEdit = dirtyElements.size > 0 || dirtyLeaves.size > 0;
      const isUserEdit = isEdit && state.userHasInteracted && !tags.has(REMOTE_UPDATE_TAG);
      if (isUserEdit) scheduleFlush(state, hooks, flush);
    });
    return () => {
      stopListening();
      flush();
    };
  };
  return {
    receive: (text) => receiveText(editor, state, text),
    flush,
    watch: (container) => watchContainer(state, container, flush),
    listen,
  };
}
