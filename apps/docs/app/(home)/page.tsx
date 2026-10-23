import Link from 'next/link';
import { CopyButton } from '../../components/CopyButton';
import { LiveWorkspace } from '../../components/LiveWorkspace';
import { RendererGallery } from '../../components/RendererGallery';
import { BROWSER_SNIPPET, INSTALL_COMMANDS, SERVER_SNIPPET } from '../../lib/snippets';

const FEATURES: readonly { title: string; body: string }[] = [
  {
    title: 'A real file tree',
    body: 'Virtualized, keyboard friendly and built on the WAI-ARIA tree pattern.',
  },
  {
    title: 'Search and tabs',
    body: 'Find files across the whole tree and keep several of them open at once.',
  },
  {
    title: 'Upload and drop',
    body: 'Drag files in, with conflict handling and progress that screen readers announce.',
  },
  {
    title: 'Live updates',
    body: 'When an agent changes a file, the tree marks it and an open viewer updates in place.',
  },
  {
    title: 'Viewers for real files',
    body: 'PDF, Word, PowerPoint, spreadsheets, Markdown, code, images, audio and video.',
  },
  {
    title: 'Safe by default',
    body: 'The server handler has no default-open mode: every request goes through your authorize function.',
  },
];

function Snippet(props: { title: string; code: string }): React.JSX.Element {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium text-fd-foreground">{props.title}</figcaption>
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-fd-border bg-fd-secondary p-4 text-sm text-fd-foreground"
      >
        <code>{props.code}</code>
      </pre>
    </figure>
  );
}

/**
 * The landing page: pitch, live demo, install commands, quick start, features and viewers.
 *
 * @example
 * <HomePage />
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-4 py-12">
      <section className="flex flex-col items-start gap-4">
        <h1 className="text-4xl font-bold tracking-tight">A file workspace for your React app</h1>
        <p className="max-w-2xl text-lg text-fd-foreground">
          A file tree, search, tabs, upload and viewers over a directory on your server, with live updates
          when an agent changes files.
        </p>
        <Link
          href="/docs"
          className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Read the documentation
        </Link>
      </section>

      <section aria-labelledby="demo-heading" className="flex flex-col gap-3">
        <h2 id="demo-heading" className="text-2xl font-semibold">
          Try it
        </h2>
        <p className="text-fd-foreground">
          This is the real component on sample files in memory. A simulated agent edits them while you watch.
        </p>
        <LiveWorkspace />
      </section>

      <section aria-labelledby="install-heading" className="flex flex-col gap-3">
        <h2 id="install-heading" className="text-2xl font-semibold">
          Install
        </h2>
        <ul className="flex flex-col gap-2">
          {INSTALL_COMMANDS.map((item) => (
            <li key={item.command} className="flex flex-wrap items-center gap-3">
              <span className="w-32 text-sm text-fd-foreground">{item.label}</span>
              <code className="rounded-md border border-fd-border bg-fd-secondary px-3 py-1.5 text-sm text-fd-foreground">
                {item.command}
              </code>
              <CopyButton text={item.command} label={`Copy: ${item.command}`} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="quick-start-heading" className="flex flex-col gap-3">
        <h2 id="quick-start-heading" className="text-2xl font-semibold">
          Quick start
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Snippet title="On the server, expose a directory" code={SERVER_SNIPPET} />
          <Snippet title="In the browser, render it" code={BROWSER_SNIPPET} />
        </div>
      </section>

      <section aria-labelledby="features-heading" className="flex flex-col gap-3">
        <h2 id="features-heading" className="text-2xl font-semibold">
          What you get
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-1 text-sm text-fd-foreground">{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="gallery-heading" className="flex flex-col gap-3">
        <h2 id="gallery-heading" className="text-2xl font-semibold">
          Viewers
        </h2>
        <RendererGallery />
      </section>
    </div>
  );
}
