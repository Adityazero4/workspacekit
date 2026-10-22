function listen<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
): () => void {
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}

/**
 * Guards unsaved edits against the page going away: `pagehide` starts saving every buffer (best effort, as
 * nothing can wait for it), and `beforeunload` asks the browser to confirm leaving while any buffer has
 * unsaved edits. Returns the removal of both listeners.
 *
 * @example
 * ```ts
 * const stop = guardUnsavedEditsOnLeave({ flushAll, hasUnsavedEdits });
 * ```
 */
export function guardUnsavedEditsOnLeave(buffers: {
  flushAll: () => void;
  hasUnsavedEdits: () => boolean;
}): () => void {
  const stopFlushing = listen('pagehide', buffers.flushAll);
  const stopAsking = listen('beforeunload', (event) => {
    if (!buffers.hasUnsavedEdits()) return;
    event.preventDefault();
    event.returnValue = true;
  });
  return () => {
    stopFlushing();
    stopAsking();
  };
}
