'use client';
import { partProps } from '@scope/react/renderer-kit';
import { $createLinkNode, $isLinkNode, $toggleLink } from '@lexical/link';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $findMatchingParent } from '@lexical/utils';
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_NORMAL,
  KEY_DOWN_COMMAND,
  type BaseSelection,
  type LexicalEditor,
} from 'lexical';
import { useEffect, useId, useRef, useState } from 'react';
import { allowedLinkUrl } from '../links';
import type { MarkdownClassNames } from '../parts';
import { belowTheSelection } from './position';

/**
 * What the link editor edits: the selection it applies to, the link URL already there (or `''`) and where
 * it is drawn. Made by `linkEditorFor`.
 *
 * @example
 * ```ts
 * const target: LinkTarget = editor.getEditorState().read(() => linkEditorFor(container));
 * ```
 */
export interface LinkTarget {
  selection: BaseSelection | null;
  url: string;
  top: number;
  left: number;
}

/**
 * The link editor's target for the current selection; call it inside `editorState.read`.
 *
 * @example
 * ```ts
 * setLinkTarget(editor.getEditorState().read(() => linkEditorFor(container)));
 * ```
 */
export function linkEditorFor(container: HTMLElement): LinkTarget {
  const selection = $getSelection();
  const anchor = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
  const link = anchor && $findMatchingParent(anchor, $isLinkNode);
  return {
    selection: selection?.clone() ?? null,
    url: link ? link.getURL() : '',
    ...belowTheSelection(container),
  };
}

/**
 * Opens the link editor on Cmd+K (macOS) or Ctrl+K while the editable text has focus.
 *
 * @example
 * ```ts
 * useEffect(() => registerLinkShortcut(editor, openLinkEditor), [editor]);
 * ```
 */
export function registerLinkShortcut(editor: LexicalEditor, open: () => void): () => void {
  return editor.registerCommand(
    KEY_DOWN_COMMAND,
    (event) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
      if (!isShortcut || !editor.isEditable()) return false;
      event.preventDefault();
      open();
      return true;
    },
    COMMAND_PRIORITY_NORMAL,
  );
}

function $applyLink(url: string | null): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const isInLink = $findMatchingParent(selection.anchor.getNode(), $isLinkNode) !== null;
  if (url !== null && selection.isCollapsed() && !isInLink) {
    selection.insertNodes([$createLinkNode(url).append($createTextNode(url))]);
    return;
  }
  $toggleLink(url);
}

interface LinkFormProps {
  initialUrl: string;
  apply: (url: string | null) => boolean;
  close: () => void;
}

function LinkForm(props: LinkFormProps): React.JSX.Element {
  const { initialUrl, apply, close } = props;
  const [url, setUrl] = useState(initialUrl);
  const [isRefused, setRefused] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setRefused(!apply(url.trim() === '' ? null : url.trim()));
      }}
    >
      <label>
        Link URL
        <input
          ref={field}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setRefused(false);
          }}
          aria-invalid={isRefused}
          aria-describedby={isRefused ? errorId : undefined}
        />
      </label>
      {isRefused && (
        <p id={errorId} role="alert">
          Use a link that starts with http://, https:// or mailto:.
        </p>
      )}
      <button type="submit">Apply</button>
      {initialUrl !== '' && (
        <button type="button" onClick={() => apply(null)}>
          Remove link
        </button>
      )}
      <button type="button" onClick={close}>
        Cancel
      </button>
    </form>
  );
}

/**
 * The link dialog: a URL field (Enter applies, Escape cancels), plus Remove for an existing link. Only
 * `http:`, `https:` and `mailto:` URLs are accepted; anything else is refused with a message. A collapsed
 * selection gets a new link whose text is the URL. Focus returns to the text when it closes.
 *
 * @example
 * ```tsx
 * {target && <LinkEditor target={target} onClose={() => setTarget(null)} />}
 * ```
 */
export function LinkEditor(props: {
  target: LinkTarget;
  onClose: () => void;
  classNames?: MarkdownClassNames;
}): React.JSX.Element {
  const { target, onClose, classNames } = props;
  const [editor] = useLexicalComposerContext();
  const close = (): void => {
    onClose();
    editor.focus();
  };
  const apply = (url: string | null): boolean => {
    if (url !== null && allowedLinkUrl(url) === null) return false;
    editor.update(() => {
      $setSelection(target.selection?.clone() ?? null);
      $applyLink(url);
    });
    close();
    return true;
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the dialog from any of its controls (WAI-ARIA dialog pattern)
    <div
      role="dialog"
      aria-label="Edit link"
      {...partProps('md-link-editor', classNames)}
      style={{ top: target.top, left: target.left }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
      }}
    >
      <LinkForm initialUrl={target.url} apply={apply} close={close} />
    </div>
  );
}
