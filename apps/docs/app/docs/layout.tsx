import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { layoutOptions } from '../../lib/layoutOptions';
import { source } from '../../lib/source';

/**
 * The documentation layout: Fumadocs' sidebar around the pages.
 *
 * @example
 * <Layout>{page}</Layout>
 */
export default function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <DocsLayout tree={source.getPageTree()} {...layoutOptions}>
      {children}
    </DocsLayout>
  );
}
