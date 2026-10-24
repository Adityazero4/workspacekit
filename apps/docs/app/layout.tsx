import { RootProvider } from 'fumadocs-ui/provider/next';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { openGraph, SITE_URL } from '../lib/layoutOptions';
import './global.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-code', display: 'swap' });
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display',
  display: 'swap',
});

const TITLE = 'workspacekit: a file workspace for agent apps';
const DESCRIPTION =
  'A React file tree, search, tabs, upload and viewers for PDF, Word, PowerPoint, spreadsheets, Markdown and code, over a directory on your server, with live updates when an agent changes files.';

/**
 * The site's default title, description and social card. Pages set their own canonical link.
 *
 * @example
 * const title = metadata.title;
 */
export const metadata: Metadata = {
  metadataBase: new URL(`${SITE_URL}/`),
  title: { default: TITLE, template: '%s | workspacekit' },
  description: DESCRIPTION,
  applicationName: 'workspacekit',
  keywords: ['React file tree', 'file workspace', 'AI agent', 'file viewer', 'PDF viewer', 'Next.js', 'Vite'],
  openGraph: openGraph({ title: TITLE, description: DESCRIPTION }),
  twitter: { card: 'summary_large_image' },
};

/**
 * The browser chrome colour and scheme: the site is dark only.
 *
 * @example
 * const colors = viewport.themeColor;
 */
export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

/**
 * The root layout: the site's typefaces and the theme provider, dark only, with search off until the static search
 * index exists.
 *
 * @example
 * <RootLayout>{page}</RootLayout>
 */
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${serif.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="alternate" type="text/markdown" title="llms.txt" href={`${SITE_URL}/llms.txt`} />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }} theme={{ forcedTheme: 'dark', defaultTheme: 'dark' }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
