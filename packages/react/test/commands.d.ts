import 'vitest/browser';
import type { MouseStep } from './support/mouseStep';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (opts: {
      colorScheme?: 'light' | 'dark' | null;
      reducedMotion?: 'reduce' | null;
    }) => Promise<void>;
    /** Drives the real mouse; `x` and `y` are offsets from the top-left of the element `selector` matches. */
    mouse: (selector: string, steps: MouseStep[]) => Promise<void>;
    firstRenderInAFreshPage: (shape: 'wide' | '10x100k' | 'chains64', files: number) => Promise<number>;
  }
}
