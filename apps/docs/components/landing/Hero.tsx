import Link from 'next/link';
import { CopyButton } from '../CopyButton';
import { LiveWorkspace } from '../LiveWorkspace';
import { Code } from './Code';
import { HeroModel } from './HeroModel';

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

function delay(milliseconds: number): React.CSSProperties {
  return { '--wk-delay': `${milliseconds}ms` } as React.CSSProperties;
}

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
    <div className="flex flex-col gap-7">
      <h1
        id="hero-heading"
        className="wk-display wk-gradient-text wk-rise text-[clamp(3.2rem,7vw,6.25rem)] leading-[0.98] text-balance"
      >
        Files your agent writes, <span className="wk-sunset-text">live</span> for your users
      </h1>
      <p style={delay(120)} className="wk-rise max-w-[48ch] text-lg leading-relaxed text-fd-muted-foreground">
        A React file tree, search, tabs, upload and real viewers for PDF, Word, PowerPoint, spreadsheets,
        Markdown and code, over a folder on your server. Every change your agent makes shows up as it happens.
      </p>
      <div style={delay(240)} className="wk-rise flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <InstallCommand tone="dark" command={STARTER} />
        <Link
          href="/docs/getting-started/next"
          className="shrink-0 text-sm font-medium text-fd-foreground hover:underline"
        >
          Documentation <span aria-hidden="true">→</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * The opening: what workspacekit is beside its mark in 3D, then the code it takes and the real component
 * running with a simulated agent.
 *
 * @example
 * <Hero />
 */
export function Hero(): React.JSX.Element {
  return (
    <section
      aria-labelledby="hero-heading"
      className="relative isolate overflow-hidden border-b border-fd-border"
    >
      <div className="mx-auto w-full max-w-7xl px-5 pt-16 pb-20 sm:px-8 lg:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <Pitch />
          <div style={delay(180)} className="wk-rise mx-auto w-full max-w-[520px]">
            <HeroModel />
          </div>
        </div>
        <div style={delay(360)} className="wk-panel wk-rise mt-16 rounded-3xl p-4 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-sm text-fd-muted-foreground">The browser side is one component:</p>
              <Code
                lang="tsx"
                label="The browser page that renders the workspace"
                code={HERO_SNIPPET}
                className="flex-1"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <h2 id="demo-heading" className="text-sm font-normal tracking-normal text-fd-muted-foreground">
                And this is what it renders, with a simulated agent at work:
              </h2>
              <div className="overflow-hidden rounded-xl border border-fd-border">
                <LiveWorkspace activity />
              </div>
            </div>
          </div>
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-sm text-fd-muted-foreground">
          {WORKS_WITH.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
