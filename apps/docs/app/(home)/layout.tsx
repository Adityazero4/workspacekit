import { HomeLayout } from 'fumadocs-ui/layouts/home';
import type { ReactNode } from 'react';
import { layoutOptions } from '../../lib/layoutOptions';

/**
 * The home layout: Fumadocs' navbar around the landing page.
 *
 * @example
 * <Layout>{page}</Layout>
 */
export default function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  return <HomeLayout {...layoutOptions}>{children}</HomeLayout>;
}
