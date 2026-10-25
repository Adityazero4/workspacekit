import type { Metadata } from 'next';
import Link from 'next/link';
import { TrustPage } from '../../../components/TrustPage';
import { openGraph, REPOSITORY_URL } from '../../../lib/layoutOptions';

const DESCRIPTION =
  'How to ask a question, report a bug, report a security problem privately or contribute to workspacekit.';

/**
 * The Contact page's title, description and canonical link.
 *
 * @example
 * const title = metadata.title;
 */
export const metadata: Metadata = {
  title: 'Contact',
  description: DESCRIPTION,
  alternates: { canonical: '/contact' },
  openGraph: openGraph({ title: 'Contact workspacekit', description: DESCRIPTION, url: '/contact' }),
};

/**
 * Where to reach the people behind workspacekit, by kind of message.
 *
 * @example
 * <ContactPage />
 */
export default function ContactPage(): React.JSX.Element {
  return (
    <TrustPage title="Contact" lead={DESCRIPTION}>
      <h2>Questions and bugs</h2>
      <p>
        Open an issue on <a href={`${REPOSITORY_URL}/issues`}>GitHub</a>. For a bug, include the package and
        version, what you expected, what happened instead, and a small example that shows it. Searching the
        existing issues first often finds an answer straight away.
      </p>
      <h2>Security problems</h2>
      <p>
        Please report a vulnerability privately, never in a public issue. Open the repository&apos;s Security
        tab and choose Report a vulnerability, or follow the other options in the{' '}
        <a href={`${REPOSITORY_URL}/blob/main/SECURITY.md`}>security policy</a>. Include the affected package
        and version, what an attacker can do, and the steps that reproduce it.
      </p>
      <h2>Contributing</h2>
      <p>
        Pull requests are welcome. The{' '}
        <a href={`${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`}>contributing guide</a> explains how to set up
        the repository, run the checks and shape a change so it can be reviewed quickly.
      </p>
      <h2>What to expect</h2>
      <p>
        workspacekit is run by volunteers. We aim to answer within a few days, but replies are best effort,
        not a guarantee. To learn more about the project first, read the <Link href="/about">about page</Link>
        .
      </p>
    </TrustPage>
  );
}
