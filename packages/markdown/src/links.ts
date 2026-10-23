import { $isLinkNode, LinkNode } from '@lexical/link';
import { safeUrlOrNull } from '@scope/react/renderer-kit';
import { $getNodeByKey, type LexicalEditor } from 'lexical';

function absoluteUrlOrNull(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

/**
 * The URL a link in a document may open: an absolute `http:` or `https:` URL (through the kit's
 * `safeUrlOrNull`) without a user name or password, or a `mailto:` address; `null` for anything else
 * (`javascript:`, `data:`, `blob:`, a credentialed URL, or a relative path, which has no meaning outside the
 * file's own site).
 *
 * @example
 * ```ts
 * allowedLinkUrl('javascript:alert(1)'); // null
 * ```
 */
export function allowedLinkUrl(url: string): string | null {
  const parsed = absoluteUrlOrNull(url);
  if (parsed?.username || parsed?.password) return null;
  if (parsed?.protocol === 'mailto:') return parsed.href;
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:' ? safeUrlOrNull(parsed.href) : null;
}

function makeSafe(anchor: HTMLElement, url: string): void {
  const href = allowedLinkUrl(url);
  if (href === null) anchor.removeAttribute('href');
  else anchor.setAttribute('href', href);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
}

/**
 * Keeps every link the editor draws safe to follow: an allowed URL (see `allowedLinkUrl`) opens in a new tab
 * with `rel="noopener noreferrer"`, and any other link has no `href` at all. The Markdown keeps the URL as
 * written. Returns the function that stops it.
 *
 * @example
 * ```ts
 * useEffect(() => registerSafeLinks(editor), [editor]);
 * ```
 */
export function registerSafeLinks(editor: LexicalEditor): () => void {
  return editor.registerMutationListener(
    LinkNode,
    (mutations) => {
      editor.getEditorState().read(() => {
        for (const [key, mutation] of mutations) {
          const anchor = mutation === 'destroyed' ? null : editor.getElementByKey(key);
          const node = $getNodeByKey(key);
          if (anchor && $isLinkNode(node)) makeSafe(anchor, node.getURL());
        }
      });
    },
    { skipInitialization: false },
  );
}
