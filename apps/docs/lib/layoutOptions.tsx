import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * The repository the site links to.
 *
 * @example
 * <a href={REPOSITORY_URL}>Source</a>
 */
export const REPOSITORY_URL = 'https://github.com/Adityazero4/workspacekit';

/**
 * The navigation shared by the home and documentation layouts.
 *
 * @example
 * <HomeLayout {...layoutOptions}>{page}</HomeLayout>
 */
export const layoutOptions: BaseLayoutProps = {
  nav: {
    title: <span className="font-display text-[1.05rem] font-semibold tracking-tight">workspacekit</span>,
  },
  links: [
    { text: 'Documentation', url: '/docs', on: 'nav' },
    { text: 'GitHub', url: REPOSITORY_URL, external: true },
  ],
};
