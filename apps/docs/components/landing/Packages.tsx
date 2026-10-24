import { CopyButton } from '../CopyButton';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const SITE = 'https://adityazero4.github.io/workspacekit';

const PACKAGES: readonly { name: string; what: string }[] = [
  { name: '@workspacekit/workspace', what: 'Everything in one component, with every viewer. Start here.' },
  { name: '@workspacekit/server', what: 'The request handler and the folder store for Node.' },
  {
    name: '@workspacekit/core',
    what: 'The adapter contract and tree store, plus HTTP and in-memory adapters.',
  },
  { name: '@workspacekit/react', what: 'The components alone, for your own layout or your own viewers.' },
  {
    name: '@workspacekit/pdf, docx, pptx, spreadsheet, markdown, code',
    what: 'One viewer each, if you want only some of them.',
  },
  { name: '@workspacekit/demo-kit', what: 'Sample files and a simulated agent for demos and tests.' },
  { name: '@workspacekit/create-workspace', what: 'A starter project for Next.js or Vite, in one command.' },
];

const AGENT_PROMPT = `Add a file workspace to this app with workspacekit. Read ${SITE}/llms.txt first, then follow the quick start for this framework. The server must check the signed-in user in authorize.`;

/**
 * The packages, so people can adopt as much or as little as they need.
 *
 * @example
 * <Layers />
 */
export function Layers(): React.JSX.Element {
  return (
    <section aria-labelledby="layers-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h2 id="layers-heading" className="max-w-[18ch] text-4xl font-bold tracking-tight text-balance">
            Take all of it, or only the part you need
          </h2>
          <p className="mt-4 max-w-[46ch] text-lg leading-relaxed text-fd-muted-foreground">
            The preset is one import. Under it, every layer is its own package, so you can bring your own
            storage, your own layout or your own viewers.
          </p>
        </div>
        <dl className="divide-y divide-fd-border border-y border-fd-border">
          {PACKAGES.map((item) => (
            <div
              key={item.name}
              className="grid gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-6"
            >
              <dt className="font-mono text-[0.85rem] break-words">{item.name}</dt>
              <dd className="text-sm text-fd-muted-foreground">{item.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/**
 * What coding agents get: machine-readable docs and a prompt to paste.
 *
 * @example
 * <ForAgents />
 */
export function ForAgents(): React.JSX.Element {
  return (
    <section aria-labelledby="agents-heading" className="mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6">
      <div className="grid gap-10 rounded-3xl border border-fd-border bg-fd-card p-6 sm:p-10 lg:grid-cols-2">
        <div>
          <h2 id="agents-heading" className="max-w-[20ch] text-3xl font-bold tracking-tight text-balance">
            Your coding agent can set it up for you
          </h2>
          <p className="mt-4 max-w-[48ch] leading-relaxed text-fd-muted-foreground">
            Every package ships an AGENTS.md and an llms.txt, and this site serves{' '}
            <a className="text-fd-foreground underline underline-offset-4" href={`${BASE_PATH}/llms.txt`}>
              llms.txt
            </a>{' '}
            and{' '}
            <a
              className="text-fd-foreground underline underline-offset-4"
              href={`${BASE_PATH}/llms-full.txt`}
            >
              llms-full.txt
            </a>
            . Paste this into Claude Code, Cursor or Codex.
          </p>
        </div>
        <figure className="flex min-w-0 flex-col gap-3 self-center">
          <blockquote className="rounded-xl border border-fd-border bg-fd-background p-4 font-mono text-[0.82rem] leading-relaxed [overflow-wrap:anywhere]">
            {AGENT_PROMPT}
          </blockquote>
          <figcaption className="flex items-center justify-between gap-3 text-sm text-fd-muted-foreground">
            A prompt for your coding agent
            <CopyButton text={AGENT_PROMPT} label="Copy the prompt for your coding agent" />
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
