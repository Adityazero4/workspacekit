import Link from 'next/link';
import { CopyButton } from '../CopyButton';
import { LiveWorkspace } from '../LiveWorkspace';
import { Code } from './Code';
import { Label } from './Type';

const INSTALL = 'npm install @workspacekit/workspace @workspacekit/core @workspacekit/server';
const STARTER = 'npm create @workspacekit/workspace my-app';

const HERO_SNIPPET = `'use client';
import { Workspace } from '@workspacekit/workspace';
import { httpAdapter } from '@workspacekit/core/http';
import '@workspacekit/workspace/styles.css';

const adapter = httpAdapter('/api/files');

export default function Files() {
  return <Workspace adapter={adapter} />;
}`;

const WORKS_WITH: readonly string[] = ['Next.js', 'Vite', 'Any Fetch API server', 'Your own storage'];

/**
 * The install command with a copy button, light or as a dark pill.
 *
 * @example
 * <InstallCommand tone="dark" command={STARTER} />
 */
export function InstallCommand(props: { tone?: 'light' | 'dark'; command?: string }): React.JSX.Element {
  const command = props.command ?? INSTALL;
  const tone =
    props.tone === 'dark'
      ? 'border-transparent bg-fd-foreground text-fd-background'
      : 'border-fd-border bg-fd-card text-fd-foreground';
  return (
    <div
      className={`flex max-w-full items-center gap-3 rounded-lg border py-1.5 pr-1.5 pl-4 text-left ${tone}`}
    >
      <code className="min-w-0 flex-1 font-mono text-[0.8rem] leading-relaxed break-words">{command}</code>
      <CopyButton text={command} label={`Copy: ${command}`} />
    </div>
  );
}

function Pitch(): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Label>~/your-app/files</Label>
      <h1
        id="hero-heading"
        className="text-[clamp(2.6rem,5.4vw,4.25rem)] leading-[1.03] text-balance text-fd-foreground"
      >
        Your agent works in files. <span className="wk-muted-phrase">Let your users watch.</span>
      </h1>
      <p className="max-w-[60ch] text-lg leading-relaxed text-fd-muted-foreground">
        A React file tree, search, tabs, upload and real viewers for PDF, Word, PowerPoint, spreadsheets,
        Markdown and code, over a folder on your server. Every change your agent makes shows up as it happens.
      </p>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <InstallCommand tone="dark" command={STARTER} />
        <Link
          href="/docs/getting-started/next"
          className="shrink-0 text-sm font-medium text-accent hover:underline"
        >
          or add it to an existing app <span aria-hidden="true">→</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * The opening: what workspacekit is, the code it takes, and the real component running with a simulated
 * agent beside it.
 *
 * @example
 * <Hero />
 */
export function Hero(): React.JSX.Element {
  return (
    <section aria-labelledby="hero-heading" className="border-b border-fd-border">
      <div className="mx-auto w-full max-w-7xl px-5 pt-16 pb-16 sm:px-8 lg:pt-24">
        <Pitch />
        <div className="mt-14 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm text-fd-muted-foreground">The browser side is one component:</p>
            <Code lang="tsx" label="The browser page that renders the workspace" code={HERO_SNIPPET} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <h2 id="demo-heading" className="text-sm font-normal tracking-normal text-fd-muted-foreground">
              And this is what it renders, with a simulated agent at work:
            </h2>
            <div className="rounded-xl border-2 border-accent">
              <LiveWorkspace activity />
            </div>
          </div>
        </div>
        <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3">
          <Label>/works-with</Label>
          {WORKS_WITH.map((item) => (
            <span key={item} className="text-sm text-fd-muted-foreground">
              {item}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
