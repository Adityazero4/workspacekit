import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * The navigation shared by the home and documentation layouts.
 *
 * @example
 * <HomeLayout {...layoutOptions}>{page}</HomeLayout>
 */
export const layoutOptions: BaseLayoutProps = {
  nav: { title: 'File workspace' },
  links: [{ text: 'Documentation', url: '/docs' }],
};
