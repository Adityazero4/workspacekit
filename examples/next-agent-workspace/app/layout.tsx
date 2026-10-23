import type { ReactNode } from 'react';

/**
 * The page title.
 *
 * @example
 * export const title = metadata.title;
 */
export const metadata = { title: 'Agent workspace' };

/**
 * The root layout: a full-height page for the workspace to fill.
 *
 * @example
 * <RootLayout>{children}</RootLayout>
 */
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body style={{ margin: 0, height: '100vh' }}>{children}</body>
    </html>
  );
}
