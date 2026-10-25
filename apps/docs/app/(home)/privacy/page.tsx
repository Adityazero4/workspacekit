import type { Metadata } from 'next';
import Link from 'next/link';
import { TrustPage } from '../../../components/TrustPage';
import { openGraph } from '../../../lib/layoutOptions';

const DESCRIPTION =
  'This site sets no cookies and runs no analytics, and the workspacekit library sends no telemetry. Here is what that means.';

/**
 * The Privacy page's title, description and canonical link.
 *
 * @example
 * const title = metadata.title;
 */
export const metadata: Metadata = {
  title: 'Privacy',
  description: DESCRIPTION,
  alternates: { canonical: '/privacy' },
  openGraph: openGraph({ title: 'Privacy at workspacekit', description: DESCRIPTION, url: '/privacy' }),
};

/**
 * What this site and the library do, and do not do, with information about visitors.
 *
 * @example
 * <PrivacyPage />
 */
export default function PrivacyPage(): React.JSX.Element {
  return (
    <TrustPage title="Privacy" lead={DESCRIPTION}>
      <h2>This website</h2>
      <ul>
        <li>It sets no cookies and runs no analytics, tracking pixels or advertising.</li>
        <li>
          It loads nothing from other companies: its fonts, scripts and images are served from this site, and
          its tests fail if the home page requests anything from another domain.
        </li>
        <li>
          The live demos run entirely in your browser on built-in sample files kept in memory. Nothing you
          type, upload or change in them is sent anywhere, and it is gone when you leave the page.
        </li>
      </ul>
      <h2>Hosting</h2>
      <p>
        The site is served by <a href="https://vercel.com/legal/privacy-policy">Vercel</a> and{' '}
        <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">
          GitHub Pages
        </a>
        . Like any web host, they keep standard request logs, such as IP addresses, the pages requested and
        browser details, under their own privacy policies.
      </p>
      <h2>The workspacekit library</h2>
      <p>
        The packages send no telemetry and contact no service of ours. Files travel only between the browser
        and the server you run, and the authorize function you write decides who may see each one.
      </p>
      <h2>Questions</h2>
      <p>
        If anything here is unclear, see the <Link href="/contact">contact page</Link>. This page was last
        updated on 25 October 2026.
      </p>
    </TrustPage>
  );
}
