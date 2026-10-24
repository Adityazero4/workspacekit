import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Include } from '../../../components/Include';
import {
  ActionsDemo,
  CustomRendererDemo,
  HeadlessTreeDemo,
  SlotPlayground,
  TokenPlayground,
} from '../../../components/LiveExamples';
import { LiveWorkspace } from '../../../components/LiveWorkspace';
import { RendererGallery } from '../../../components/RendererGallery';
import { openGraph } from '../../../lib/layoutOptions';
import { source } from '../../../lib/source';

const MDX_COMPONENTS = {
  ...defaultMdxComponents,
  ActionsDemo,
  CustomRendererDemo,
  HeadlessTreeDemo,
  Include,
  LiveWorkspace,
  RendererGallery,
  SlotPlayground,
  TokenPlayground,
};

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

/**
 * One documentation page, rendered from its MDX file.
 *
 * @example
 * <Page params={Promise.resolve({ slug: ['guide'] })} />
 */
export default async function Page(props: PageProps): Promise<React.JSX.Element> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const Content = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Content components={MDX_COMPONENTS} />
      </DocsBody>
    </DocsPage>
  );
}

/**
 * Every documentation slug, so the static export writes one page per file.
 *
 * @example
 * const params = generateStaticParams();
 */
export function generateStaticParams(): { slug: string[] }[] {
  return source.generateParams();
}

/**
 * The title, description and canonical link of the page, from its front matter.
 *
 * @example
 * const metadata = await generateMetadata({ params });
 */
export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: openGraph({ title: page.data.title, description: page.data.description, url: page.url }),
  };
}
