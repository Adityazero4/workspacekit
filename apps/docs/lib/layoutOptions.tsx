import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import type { Metadata } from 'next';
import { GitHubIcon, NpmIcon } from '../components/BrandIcons';
import { Logo } from '../components/Logo';

/**
 * Where the site is published, without a trailing slash: `NEXT_PUBLIC_SITE_URL` when the host sets it, such
 * as on Vercel, and the GitHub Pages address otherwise. Canonical links, the sitemap and social cards use it.
 *
 * @example
 * const home = `${SITE_URL}/`;
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://adityazero4.github.io/workspacekit';

/**
 * A page's Open Graph fields with the site name and social card filled in. Next replaces `openGraph` whole
 * when a page sets it, so every page builds it here instead of inheriting the card from the root layout.
 *
 * @example
 * export const metadata = { openGraph: openGraph({ url: '/' }) };
 */
export function openGraph(fields: NonNullable<Metadata['openGraph']>): NonNullable<Metadata['openGraph']> {
  return {
    type: 'website',
    siteName: 'workspacekit',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'workspacekit: files your agent writes, live for your users',
      },
    ],
    ...fields,
  };
}

/**
 * The repository the site links to.
 *
 * @example
 * <a href={REPOSITORY_URL}>Source</a>
 */
export const REPOSITORY_URL = 'https://github.com/Adityazero4/workspacekit';

/**
 * The npm page of the preset package, the one an app installs.
 *
 * @example
 * <a href={NPM_URL}>npm</a>
 */
export const NPM_URL = 'https://www.npmjs.com/package/@workspacekit/workspace';

/**
 * The navigation shared by the home and documentation layouts.
 *
 * @example
 * <HomeLayout {...layoutOptions}>{page}</HomeLayout>
 */
export const layoutOptions: BaseLayoutProps = {
  nav: {
    title: <Logo />,
  },
  slots: { themeSwitch: false },
  links: [
    { text: 'Documentation', url: '/docs', on: 'nav' },
    {
      type: 'icon',
      label: 'GitHub',
      text: 'GitHub',
      icon: <GitHubIcon />,
      url: REPOSITORY_URL,
      external: true,
    },
    { type: 'icon', label: 'npm', text: 'npm', icon: <NpmIcon />, url: NPM_URL, external: true },
  ],
};
