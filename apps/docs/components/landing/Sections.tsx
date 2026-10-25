import Link from 'next/link';
import { BROWSER_SNIPPET, SERVER_SNIPPET } from '../../lib/snippets';
import { GitHubIcon, NpmIcon } from '../BrandIcons';
import { NPM_URL, REPOSITORY_URL } from '../../lib/layoutOptions';
import { RendererGallery } from '../RendererGallery';
import { Code } from './Code';
import { InstallCommand } from './Hero';
import { Label, Title } from './Type';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const COMPARISON: readonly { need: string; diy: string; kit: string }[] = [
  {
    need: 'A tree that stays fast with huge folders',
    diy: 'Virtualize it, then keep expand, select and rename correct while it scrolls',
    kit: 'Virtualized, with budgets tested on trees of a million files',
  },
  {
    need: 'Open Office files and PDFs',
    diy: 'Wire up a library per format and sandbox whatever HTML each one produces',
    kit: 'Nine viewers, loaded on demand; Word and PowerPoint render inside a locked-down shadow root',
  },
  {
    need: 'See the agent’s changes live',
    diy: 'Design a watch protocol, reconnects, missed-event recovery and a fallback',
    kit: 'A server-sent stream that resyncs after a drop and falls back to polling',
  },
  {
    need: 'Uploads people trust',
    diy: 'Chunking, retries, progress and what happens when the name is taken',
    kit: 'Chunked uploads with progress, retries and a choice on every name clash',
  },
  {
    need: 'Keep private files private',
    diy: 'Remember the check on every route, including links and downloads',
    kit: 'One authorize function the handler calls for every request, with no way to skip it',
  },
];

const GUARANTEES: readonly string[] = [
  'authorize(request, operation, path) runs on every request and must return exactly true.',
  'A link is checked twice: as the path asked for and as the file it really points to.',
  'Each file in a folder download is checked again at the moment it is read.',
  'Uploads, live streams and folder walks have limits per user, so one client cannot starve the rest.',
  'Responses are never cached by the browser and never content-sniffed.',
];

const SECURE_SNIPPET = `// app/api/files/[...path]/route.ts
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

export const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (request, operation, path) => {
    const user = await currentUser(request);
    if (!user) return false;
    if (operation === 'delete') return user.isAdmin;
    return path.startsWith(\`users/\${user.id}/\`);
  },
});`;

function Section(props: { id: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <section aria-labelledby={props.id} className={`border-t border-fd-border ${props.className ?? ''}`}>
      <div className="mx-auto w-full max-w-7xl px-5 py-28 sm:px-8">{props.children}</div>
    </section>
  );
}

/**
 * The viewer gallery: every renderer on a real sample file.
 *
 * @example
 * <Gallery />
 */
export function Gallery(): React.JSX.Element {
  return (
    <Section id="gallery-heading">
      <div className="flex flex-col gap-5">
        <Label>/viewers</Label>
        <Title id="gallery-heading" lead="Nine viewers." rest="Every file your agent makes." />
      </div>
      <div className="wk-card mt-12 rounded-xl p-4 sm:p-6">
        <RendererGallery />
      </div>
    </Section>
  );
}

/**
 * What building a file workspace yourself takes, next to what workspacekit already does.
 *
 * @example
 * <Comparison />
 */
export function Comparison(): React.JSX.Element {
  return (
    <Section id="compare-heading">
      <div className="flex flex-col gap-5">
        <Label>/build-or-install</Label>
        <Title id="compare-heading" lead="The part of your app" rest="you should not have to build." />
      </div>
      <dl className="wk-reveal-each mt-14 border-t border-fd-border">
        {COMPARISON.map((row) => (
          <div
            key={row.need}
            className="grid gap-3 border-b border-fd-border py-7 md:grid-cols-[1fr_1.2fr_1.2fr] md:gap-8"
          >
            <dt className="text-lg text-fd-foreground">{row.need}</dt>
            <dd className="text-[0.95rem] leading-relaxed text-fd-muted-foreground">
              <span className="mb-1.5 block text-xs font-medium text-fd-muted-foreground">On your own</span>
              {row.diy}
            </dd>
            <dd className="text-[0.95rem] leading-relaxed text-fd-foreground">
              <span className="mb-1.5 block text-xs font-medium text-fd-foreground">With workspacekit</span>
              {row.kit}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/**
 * The server's security guarantees, beside the handler that provides them.
 *
 * @example
 * <Security />
 */
export function Security(): React.JSX.Element {
  return (
    <Section id="security-heading" className="bg-band">
      <div className="grid gap-14 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Label>/security</Label>
          <Title id="security-heading" lead="Closed until" rest="you open it." />
          <p className="max-w-[46ch] text-lg leading-relaxed text-fd-muted-foreground">
            An agent’s folder often holds things only some people may see. The handler has no open mode: you
            decide, per request and per path.
          </p>
          <ul className="wk-reveal-each mt-2 flex flex-col">
            {GUARANTEES.map((guarantee) => (
              <li
                key={guarantee}
                className="border-b border-fd-border py-4 text-[0.95rem] leading-relaxed last:border-0"
              >
                {guarantee}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 lg:pt-16">
          <Code lang="ts" label="A server route that checks the signed-in user" code={SECURE_SNIPPET} />
        </div>
      </div>
    </Section>
  );
}

/**
 * Three steps from install to a working workspace.
 *
 * @example
 * <QuickStart />
 */
export function QuickStart(): React.JSX.Element {
  return (
    <Section id="start-heading">
      <div className="flex flex-col gap-5">
        <Label>/quick-start</Label>
        <Title id="start-heading" lead="Running in" rest="three steps." />
      </div>
      <ol className="wk-reveal-each mt-14 flex flex-col">
        {[
          { title: 'Install the packages.', body: <InstallCommand /> },
          {
            title: 'Expose a folder on the server.',
            body: <Code lang="ts" label="Step 2: the server route" code={SERVER_SNIPPET} />,
          },
          {
            title: 'Render it in the browser.',
            body: <Code lang="tsx" label="Step 3: the browser page" code={BROWSER_SNIPPET} />,
          },
        ].map((step, index) => (
          <li
            key={step.title}
            className="grid min-w-0 gap-4 border-t border-fd-border py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10"
          >
            <div className="flex flex-col gap-3">
              <span className="font-mono text-xs text-fd-muted-foreground">0{index + 1}</span>
              <h3 className="text-xl">{step.title}</h3>
            </div>
            <div className="min-w-0">{step.body}</div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * The closing call to action and the footer.
 *
 * @example
 * <Closing />
 */
export function Closing(): React.JSX.Element {
  return (
    <>
      <section aria-labelledby="closing-heading" className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-5 py-32 text-center sm:px-8">
          <Label>/get-started</Label>
          <Title id="closing-heading" lead="Show people" rest="what your agent did." />
          <div className="flex flex-wrap items-center justify-center gap-6">
            <Link
              href="/docs/getting-started/next"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 dark:text-slate-950"
            >
              Add it to your app <span aria-hidden="true">→</span>
            </Link>
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fd-muted-foreground hover:text-fd-foreground"
            >
              Source on GitHub <span aria-hidden="true">↗</span>
            </a>
            <a
              href={NPM_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fd-muted-foreground hover:text-fd-foreground"
            >
              Package on npm <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>
      <footer className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-fd-muted-foreground sm:px-8">
          <p>workspacekit is open source under the Apache-2.0 licence.</p>
          <nav aria-label="Footer" className="flex items-center gap-6">
            <Link href="/docs" className="hover:text-fd-foreground">
              Docs
            </Link>
            <Link href="/about" className="hover:text-fd-foreground">
              About
            </Link>
            <Link href="/contact" className="hover:text-fd-foreground">
              Contact
            </Link>
            <Link href="/privacy" className="hover:text-fd-foreground">
              Privacy
            </Link>
            <a href={`${BASE_PATH}/llms.txt`} className="hover:text-fd-foreground">
              llms.txt
            </a>
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="hover:text-fd-foreground"
            >
              <GitHubIcon />
            </a>
            <a
              href={NPM_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="npm"
              className="hover:text-fd-foreground"
            >
              <NpmIcon />
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
