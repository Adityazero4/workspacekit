import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { notFound } from 'next/navigation';
import { apiSource } from '../../../lib/source';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

/**
 * One API reference page: the generated documentation of a package.
 *
 * @example
 * <Page params={Promise.resolve({ slug: ['core'] })} />
 */
export default async function Page(props: PageProps): Promise<React.JSX.Element> {
  const { slug } = await props.params;
  const page = apiSource.getPage(slug);
  if (!page) notFound();
  const Content = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Content components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

/**
 * Every API slug, so the static export writes one page per package.
 *
 * @example
 * const params = generateStaticParams();
 */
export function generateStaticParams(): { slug: string[] }[] {
  return apiSource.generateParams();
}

/**
 * The title and description of the page, from its front matter.
 *
 * @example
 * const metadata = await generateMetadata({ params });
 */
export async function generateMetadata(props: PageProps): Promise<{ title: string; description?: string }> {
  const { slug } = await props.params;
  const page = apiSource.getPage(slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
