import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { layoutOptions } from '../../lib/layoutOptions';
import { apiSource } from '../../lib/source';

/**
 * The API reference layout: Fumadocs' sidebar listing one page per package.
 *
 * @example
 * <Layout>{page}</Layout>
 */
export default function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <DocsLayout tree={apiSource.getPageTree()} {...layoutOptions}>
      {children}
    </DocsLayout>
  );
}
