import 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (options: { colorScheme?: 'light' | 'dark' | null }) => Promise<void>;
  }
}
