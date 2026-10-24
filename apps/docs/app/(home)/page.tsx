import type { Metadata } from 'next';
import { ChangeFlow } from '../../components/landing/ChangeFlow';
import { Faq } from '../../components/landing/Faq';
import { Hero } from '../../components/landing/Hero';
import { Inside } from '../../components/landing/Inside';
import { ForAgents, Layers } from '../../components/landing/Packages';
import { Closing, Comparison, Gallery, QuickStart, Security } from '../../components/landing/Sections';
import { NPM_URL, openGraph, REPOSITORY_URL, SITE_URL } from '../../lib/layoutOptions';

/**
 * The home page's canonical link.
 *
 * @example
 * const canonical = metadata.alternates?.canonical;
 */
export const metadata: Metadata = {
  alternates: { canonical: './' },
  openGraph: openGraph({ url: './' }),
};

const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: 'workspacekit',
  description:
    'A React file workspace for agent apps: file tree, search, tabs, upload and viewers over a directory on your server, with live updates.',
  url: `${SITE_URL}/`,
  codeRepository: REPOSITORY_URL,
  programmingLanguage: ['TypeScript', 'React'],
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  sameAs: [NPM_URL],
});

/**
 * The landing page: the live demo, how a change reaches the screen, what is inside, the viewers, building
 * it yourself, security, the quick start, the packages, coding agents and common questions.
 *
 * @example
 * <HomePage />
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className="flex w-full flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: STRUCTURED_DATA }} />
      <Hero />
      <ChangeFlow />
      <Inside />
      <Gallery />
      <Comparison />
      <Security />
      <QuickStart />
      <Layers />
      <ForAgents />
      <Faq />
      <Closing />
    </div>
  );
}
