/**
 * One step of the `mouse` browser command: move to an offset from the element's top-left corner, press or
 * release the primary button, or turn the wheel (optionally with a modifier key held).
 */
export type MouseStep =
  { x: number; y: number } | 'down' | 'up' | { wheel: number; holding?: 'Control' | 'Meta' };
