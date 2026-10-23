const LARGE_DOCUMENT_CHARACTERS = 1024 * 1024;
const LARGE_DOCUMENT_REPORT_DELAY_MS = 300;

/**
 * Hands a document's edits to `deliver`: at once up to 1 MiB (1,048,576 characters), and after a 300 ms
 * pause in typing above that, because reporting means serialising the whole document. `flush` reports a
 * pending edit now (call it on blur, unmount and when the page hides). A batch of pending edits goes to the
 * `deliver` given with its first edit, so a callback that records the version an edit was based on stays
 * right even if a newer callback arrives before the pause ends.
 *
 * @example
 * ```ts
 * const reporter = editReporter<Text>();
 * reporter.changed(update.state.doc, (doc) => onChange(doc.toString()));
 * ```
 */
export function editReporter<Doc extends { length: number }>(): {
  changed: (doc: Doc, deliver: (doc: Doc) => void) => void;
  flush: () => void;
} {
  let pending: { doc: Doc; deliver: (doc: Doc) => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) return;
    const { doc, deliver } = pending;
    pending = undefined;
    deliver(doc);
  };
  const changed = (doc: Doc, deliver: (doc: Doc) => void): void => {
    pending = { doc, deliver: pending?.deliver ?? deliver };
    if (doc.length <= LARGE_DOCUMENT_CHARACTERS) return flush();
    clearTimeout(timer);
    timer = setTimeout(flush, LARGE_DOCUMENT_REPORT_DELAY_MS);
  };
  return { changed, flush };
}
