import Link from 'next/link';
import { BROWSER_SNIPPET, SERVER_SNIPPET } from '../../lib/snippets';
import { REPOSITORY_URL } from '../../lib/layoutOptions';
import { RendererGallery } from '../RendererGallery';
import { Code } from './Code';
import { InstallCommand } from './Hero';

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

function SectionHeading(props: { id: string; title: string; lead: string }): React.JSX.Element {
  return (
    <>
      <h2 id={props.id} className="max-w-[24ch] text-4xl font-bold tracking-tight text-balance">
        {props.title}
      </h2>
      <p className="mt-4 max-w-[62ch] text-lg leading-relaxed text-fd-muted-foreground">{props.lead}</p>
    </>
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
    <section aria-labelledby="compare-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
      <SectionHeading
        id="compare-heading"
        title="The part of your agent app you should not have to build"
        lead="Showing files to people looks small until you build it. Here is what is behind each line."
      />
      <ul className="mt-10 flex flex-col gap-4 md:hidden">
        {COMPARISON.map((row) => (
          <li key={row.need} className="rounded-2xl border border-fd-border bg-fd-card p-5">
            <h3 className="font-semibold">{row.need}</h3>
            <p className="mt-3 text-sm text-fd-muted-foreground">Building it yourself: {row.diy}</p>
            <p className="mt-2 text-sm">With workspacekit: {row.kit}</p>
          </li>
        ))}
      </ul>
      <div className="mt-10 hidden overflow-x-auto rounded-2xl border border-fd-border bg-fd-card md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-fd-border text-fd-muted-foreground">
            <tr>
              <th scope="col" className="w-[26%] px-5 py-3 font-medium">
                You need
              </th>
              <th scope="col" className="w-[37%] px-5 py-3 font-medium">
                Building it yourself
              </th>
              <th scope="col" className="px-5 py-3 font-medium text-fd-foreground">
                With workspacekit
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON.map((row) => (
              <tr key={row.need} className="border-b border-fd-border last:border-0">
                <th scope="row" className="px-5 py-4 align-top font-semibold">
                  {row.need}
                </th>
                <td className="px-5 py-4 align-top text-fd-muted-foreground">{row.diy}</td>
                <td className="px-5 py-4 align-top">{row.kit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
    <section aria-labelledby="security-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2">
        <div>
          <SectionHeading
            id="security-heading"
            title="Closed until you open it"
            lead="An agent's folder often holds things only some people may see. The server handler has no open mode: you decide, per request and per path."
          />
          <ul className="mt-8 flex flex-col gap-4">
            {GUARANTEES.map((guarantee) => (
              <li key={guarantee} className="flex gap-3 text-[0.95rem] leading-relaxed">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-blue" />
                {guarantee}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 self-center">
          <Code lang="ts" label="A server route that checks the signed-in user" code={SECURE_SNIPPET} />
        </div>
      </div>
    </section>
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
    <section aria-labelledby="start-heading" className="border-y border-fd-border bg-fd-card">
      <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          id="start-heading"
          title="Running in three steps"
          lead="Next.js shown here. Any server that speaks the Fetch API works the same way, and there is a Vite guide too."
        />
        <ol className="mt-10 flex flex-col gap-10">
          <li className="flex max-w-3xl min-w-0 flex-col gap-3">
            <h3 className="text-lg font-semibold">1. Install</h3>
            <InstallCommand />
          </li>
          <li className="grid min-w-0 gap-10 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="text-lg font-semibold">2. Expose a folder on the server</h3>
              <Code lang="ts" label="Step 2: the server route" code={SERVER_SNIPPET} />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="text-lg font-semibold">3. Render it in the browser</h3>
              <Code lang="tsx" label="Step 3: the browser page" code={BROWSER_SNIPPET} />
            </div>
          </li>
        </ol>
      </div>
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
    <section aria-labelledby="gallery-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
      <SectionHeading
        id="gallery-heading"
        title="Open the files your agent produces"
        lead="Each viewer below is the one the workspace uses, on a real sample file."
      />
      <div className="mt-8">
        <RendererGallery />
      </div>
    </section>
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
      <section aria-labelledby="closing-heading" className="mx-auto w-full max-w-7xl px-4 py-24 sm:px-6">
        <h2 id="closing-heading" className="max-w-[20ch] text-5xl font-bold tracking-tight text-balance">
          Put your agent’s work where people can see it.
        </h2>
        <div className="mt-8 flex max-w-2xl flex-col gap-4">
          <InstallCommand />
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground hover:opacity-90"
            >
              Read the docs
            </Link>
            <a
              href={REPOSITORY_URL}
              className="rounded-lg border border-fd-border bg-fd-card px-4 py-2.5 text-sm font-medium hover:bg-fd-accent"
            >
              Source on GitHub
            </a>
          </div>
        </div>
      </section>
      <footer className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap justify-between gap-4 px-4 py-8 text-sm text-fd-muted-foreground sm:px-6">
          <p>workspacekit is open source under the Apache-2.0 licence.</p>
          <nav aria-label="Footer" className="flex gap-6">
            <Link href="/docs" className="hover:text-fd-foreground">
              Docs
            </Link>
            <a href={`${BASE_PATH}/llms.txt`} className="hover:text-fd-foreground">
              llms.txt
            </a>
            <a href={REPOSITORY_URL} className="hover:text-fd-foreground">
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
