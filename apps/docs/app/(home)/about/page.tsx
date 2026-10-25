import type { Metadata } from 'next';
import Link from 'next/link';
import { TrustPage } from '../../../components/TrustPage';
import { NPM_URL, openGraph, REPOSITORY_URL } from '../../../lib/layoutOptions';

const DESCRIPTION =
  'What workspacekit is, who it is for, how it is built and tested, and who maintains it under the Apache-2.0 licence.';

/**
 * The About page's title, description and canonical link.
 *
 * @example
 * const title = metadata.title;
 */
export const metadata: Metadata = {
  title: 'About',
  description: DESCRIPTION,
  alternates: { canonical: '/about' },
  openGraph: openGraph({ title: 'About workspacekit', description: DESCRIPTION, url: '/about' }),
};

/**
 * What workspacekit is and who stands behind it.
 *
 * @example
 * <AboutPage />
 */
export default function AboutPage(): React.JSX.Element {
  return (
    <TrustPage title="About workspacekit" lead={DESCRIPTION}>
      <h2>What it is</h2>
      <p>
        workspacekit is an open-source React library that shows the files an AI agent writes. It gives an app
        a file tree, search, tabs, upload and viewers for PDF, Word, PowerPoint, spreadsheets, Markdown and
        code, over a folder on your server, and it updates live while the agent works. One component renders
        all of it, and every part is also available on its own.
      </p>
      <h2>Who it is for</h2>
      <p>
        Teams building agent apps in React, where people need to see, open, check and manage what an agent
        produced: reports, spreadsheets, documents and code. It runs with Next.js, Vite or any server that
        speaks the Fetch API.
      </p>
      <h2>How it is built</h2>
      <ul>
        <li>Written in TypeScript and split into small packages under the @workspacekit scope.</li>
        <li>Tested in Chromium, Firefox and WebKit on every change, with accessibility checks by axe.</li>
        <li>Held to performance budgets measured on trees of a million files.</li>
        <li>
          Closed by default on the server: a required authorize function decides every request, so nothing is
          shared until your code allows it.
        </li>
      </ul>
      <h2>Who maintains it</h2>
      <p>
        workspacekit is a volunteer-run project maintained on GitHub by{' '}
        <a href="https://github.com/Adityazero4">Adityazero4</a>, and contributions are welcome. The source is
        on <a href={REPOSITORY_URL}>GitHub</a>, and releases go to <a href={NPM_URL}>npm</a>. It has not had a
        stable release yet, so expect changes before 1.0.
      </p>
      <h2>Licence</h2>
      <p>
        The code is free to use, change and ship under the Apache-2.0 licence. There is no account, no hosted
        service and nothing to pay. To get in touch, see the <Link href="/contact">contact page</Link>.
      </p>
    </TrustPage>
  );
}
