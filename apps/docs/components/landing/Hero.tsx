import Link from 'next/link';
import { REPOSITORY_URL } from '../../lib/layoutOptions';
import { CopyButton } from '../CopyButton';
import { LiveWorkspace } from '../LiveWorkspace';

const INSTALL = 'npm install @workspacekit/workspace @workspacekit/core @workspacekit/server';

const FACTS: readonly string[] = [
  'Open source under Apache-2.0',
  'Every request goes through your authorize function',
  'Tested in Chromium, Firefox and WebKit on every change',
  'Trees of a million files stay fast',
  'Every code sample in the docs type-checks in CI',
];

/**
 * The install command with a copy button.
 *
 * @example
 * <InstallCommand />
 */
export function InstallCommand(): React.JSX.Element {
  return (
    <div className="flex max-w-full items-center gap-2 rounded-lg border border-fd-border bg-fd-card py-1.5 pr-1.5 pl-3.5">
      <code className="min-w-0 flex-1 font-mono text-[0.82rem] leading-relaxed break-words text-fd-foreground">
        {INSTALL}
      </code>
      <CopyButton text={INSTALL} label="Copy the install command" />
    </div>
  );
}

/**
 * The opening: what workspacekit is, how to install it, and the real component running with an agent.
 *
 * @example
 * <Hero />
 */
export function Hero(): React.JSX.Element {
  return (
    <section aria-labelledby="hero-heading" className="wk-dots relative isolate">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 pt-14 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-14 lg:pt-20">
        <div className="flex flex-col gap-6 lg:pt-6">
          <h1
            id="hero-heading"
            className="text-[clamp(2.4rem,4.3vw,3.75rem)] leading-[1.04] font-bold tracking-[-0.03em] text-balance"
          >
            A file workspace your agent can actually work in.
          </h1>
          <p className="max-w-[46ch] text-lg leading-relaxed text-fd-muted-foreground">
            workspacekit puts a file tree, search, tabs, upload and real viewers for PDF, Word, PowerPoint,
            spreadsheets, Markdown and code over a folder on your server. When your agent changes a file, your
            users see it happen, highlighted.
          </p>
          <InstallCommand />
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs/getting-started/next"
              className="rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
            >
              Read the quick start
            </Link>
            <a
              href={REPOSITORY_URL}
              className="rounded-lg border border-fd-border bg-fd-card px-4 py-2.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
            >
              Source on GitHub
            </a>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h2 id="demo-heading" className="font-sans text-sm font-medium text-fd-foreground">
            Try it: an agent is editing these files right now
          </h2>
          <LiveWorkspace activity />
          <p className="text-sm text-fd-muted-foreground">
            This is the real component, on sample files in your browser. The agent's edits are simulated.
          </p>
        </div>
      </div>
      <ul className="mx-auto flex w-full max-w-7xl flex-wrap gap-x-8 gap-y-2 border-t border-fd-border px-4 py-5 text-sm text-fd-muted-foreground sm:px-6">
        {FACTS.map((fact) => (
          <li key={fact} className="flex items-center gap-2">
            <span aria-hidden="true" className="size-1 rounded-full bg-fd-muted-foreground" />
            {fact}
          </li>
        ))}
      </ul>
    </section>
  );
}
