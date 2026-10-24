import { CopyButton } from '../CopyButton';
import { Label, Title } from './Type';

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
  { name: '@workspacekit/pdf, docx, pptx and more', what: 'One viewer each, if you want only some of them.' },
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
    <section aria-labelledby="layers-heading" className="border-t border-fd-border">
      <div className="mx-auto grid w-full max-w-7xl gap-14 px-5 py-28 sm:px-8 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Label>/packages</Label>
          <Title id="layers-heading" lead="Take all of it," rest="or only what you need." />
          <p className="max-w-[44ch] text-lg leading-relaxed text-fd-muted-foreground">
            The preset is one import. Under it every layer is its own package, so you can bring your own
            storage, layout or viewers.
          </p>
        </div>
        <dl className="wk-reveal-each border-t border-fd-border">
          {PACKAGES.map((item) => (
            <div
              key={item.name}
              className="grid gap-1 border-b border-fd-border py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6"
            >
              <dt className="font-mono text-[0.82rem] break-words text-fd-foreground">{item.name}</dt>
              <dd className="text-[0.95rem] text-fd-muted-foreground">{item.what}</dd>
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
    <section aria-labelledby="agents-heading" className="border-t border-fd-border">
      <div className="mx-auto grid w-full max-w-7xl gap-14 px-5 py-28 sm:px-8 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Label>/agents</Label>
          <Title id="agents-heading" lead="Your coding agent" rest="can set it up for you." />
          <p className="max-w-[46ch] text-lg leading-relaxed text-fd-muted-foreground">
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
        <figure className="wk-card flex min-w-0 flex-col gap-4 self-center rounded-xl p-6">
          <figcaption className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-fd-muted-foreground">Prompt</span>
            <CopyButton text={AGENT_PROMPT} label="Copy the prompt for your coding agent" />
          </figcaption>
          <blockquote className="font-mono text-[0.85rem] leading-relaxed [overflow-wrap:anywhere] text-fd-foreground">
            {AGENT_PROMPT}
          </blockquote>
        </figure>
      </div>
    </section>
  );
}
