import 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (opts: {
      colorScheme?: 'light' | 'dark' | null;
      reducedMotion?: 'reduce' | null;
    }) => Promise<void>;
    firstRenderInAFreshPage: (shape: 'wide' | '10x100k' | 'chains64', files: number) => Promise<number>;
  }
}
