import { animationFrames } from './animationFrames';

/**
 * Resolves once the work an interaction started has run: its promise chains, the zero-delay tasks they
 * queue (focus returns are one) and the renders after them, three frames on. Await it before asserting
 * that nothing more happens. It is not a timer and works under fake timers: work behind a real delay (a
 * debounce, autosave, follow, a flash, a hover) needs `vi.advanceTimersByTimeAsync` instead.
 */
export const interactionSettled = (): Promise<void> => animationFrames(3);
