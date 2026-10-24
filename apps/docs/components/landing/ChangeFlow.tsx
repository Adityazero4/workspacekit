import { Label, Title } from './Type';

const STEPS: readonly { where: string; title: string; body: string }[] = [
  {
    where: 'Any process',
    title: 'Your agent writes a file.',
    body: 'It writes to the folder the way it already does. No SDK, no special API.',
  },
  {
    where: 'nodeFsStore',
    title: 'The server notices.',
    body: 'The store watches the folder and batches bursts. Hidden, temporary and excluded paths never leave it.',
  },
  {
    where: 'createFileHandler',
    title: 'The browser hears about it.',
    body: 'Changes stream to every workspace your authorize allows, and catch up after a dropped connection.',
  },
  {
    where: 'Workspace',
    title: 'Your user sees it.',
    body: 'The row is marked, and a file that is open reloads in place. Nobody has to refresh.',
  },
];

/**
 * How one change travels from the agent to the screen: four numbered steps joined by a moving line.
 *
 * @example
 * <ChangeFlow />
 */
export function ChangeFlow(): React.JSX.Element {
  return (
    <section
      aria-labelledby="flow-heading"
      className="mx-auto w-full max-w-7xl scroll-mt-20 px-5 py-28 sm:px-8"
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-end">
        <div className="flex flex-col gap-5">
          <Label>/how-it-works</Label>
          <Title id="flow-heading" lead="From your agent’s write" rest="to your user’s screen." />
        </div>
        <p className="max-w-[40ch] leading-relaxed text-fd-muted-foreground lg:justify-self-end">
          Live updates work out of the box. If the server refuses the live stream, the browser polls instead
          and says so once.
        </p>
      </div>
      <ol className="wk-reveal-each mt-16 grid lg:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative flex gap-5 pb-12 lg:flex-col lg:gap-6 lg:pr-10 lg:pb-0">
            <span className="z-10 grid size-9 shrink-0 place-items-center rounded-full border border-fd-border bg-fd-background font-mono text-xs text-fd-muted-foreground">
              {String(index + 1).padStart(2, '0')}
            </span>
            {index < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className="wk-wire"
                style={{ '--wk-wire-delay': `${index * 0.6}s` } as React.CSSProperties}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[0.75rem] text-fd-muted-foreground">{step.where}</span>
              <h3 className="text-xl text-fd-foreground">{step.title}</h3>
              <p className="max-w-[34ch] text-[0.95rem] leading-relaxed text-fd-muted-foreground">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
