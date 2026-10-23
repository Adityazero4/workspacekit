/**
 * Where a popover anchored to the current text selection goes, in pixels from the top left of `container`
 * (which is positioned): just below the selection, or at the container's top left when there is none.
 *
 * @example
 * ```ts
 * const { top, left } = belowTheSelection(container);
 * ```
 */
export function belowTheSelection(container: HTMLElement): { top: number; left: number } {
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const rect = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return { top: 0, left: 0 };
  return {
    top: rect.bottom - box.top + container.scrollTop + 4,
    left: Math.max(0, rect.left - box.left + container.scrollLeft),
  };
}
