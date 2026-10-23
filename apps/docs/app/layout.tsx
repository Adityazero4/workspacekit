import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import './global.css';

/**
 * The site's default title and description.
 *
 * @example
 * const title = metadata.title.default;
 */
export const metadata = {
  title: { default: 'File workspace', template: '%s | File workspace' },
  description: 'A React file tree, search, tabs, upload and viewers over a directory on a server.',
};

/**
 * The root layout: the theme provider, with search off until the static search index exists.
 *
 * @example
 * <RootLayout>{page}</RootLayout>
 */
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
