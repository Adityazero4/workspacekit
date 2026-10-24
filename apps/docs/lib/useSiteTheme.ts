'use client';
import { useTheme } from 'fumadocs-ui/provider/base';
import { useSyncExternalStore } from 'react';

const subscribeToNothing = (): (() => void) => () => undefined;

/**
 * The site's resolved theme once the page has hydrated, and `undefined` before that, so a demo renders the
 * same markup on the server and in the browser's first render.
 *
 * @example
 * const theme = useSiteTheme();
 */
export function useSiteTheme(): 'light' | 'dark' | undefined {
  const { resolvedTheme } = useTheme();
  const isHydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  if (!isHydrated) return undefined;
  return resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : undefined;
}
