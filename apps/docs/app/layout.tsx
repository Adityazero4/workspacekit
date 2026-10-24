import { RootProvider } from 'fumadocs-ui/provider/next';
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './global.css';

const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-code',
  display: 'swap',
});

/**
 * The site's default title and description.
 *
 * @example
 * const title = metadata.title.default;
 */
export const metadata = {
  title: { default: 'workspacekit: a file workspace for agent apps', template: '%s | workspacekit' },
  description:
    'A React file tree, search, tabs, upload and viewers for PDF, Word, PowerPoint, spreadsheets, Markdown and code, over a directory on your server, with live updates when an agent changes files.',
};

/**
 * The root layout: the site's typefaces and the theme provider, with search off until the static search
 * index exists.
 *
 * @example
 * <RootLayout>{page}</RootLayout>
 */
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
