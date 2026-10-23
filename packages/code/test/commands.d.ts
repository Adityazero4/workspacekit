import 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (options: { reducedMotion?: 'reduce' | null }) => Promise<void>;
  }
}
