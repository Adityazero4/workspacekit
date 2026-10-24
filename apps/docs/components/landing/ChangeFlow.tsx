const STEPS: readonly { where: string; title: string; body: string }[] = [
  {
    where: 'Any process',
    title: 'Your agent writes a file',
    body: 'It writes to the folder the way it already does. No SDK, no special API.',
  },
  {
    where: 'nodeFsStore',
    title: 'The server notices',
    body: 'The store watches the folder and batches bursts. Hidden, temporary and excluded paths never leave it.',
  },
  {
    where: 'createFileHandler',
    title: 'The browser hears about it',
    body: 'Changes stream to every open workspace your authorize allows. After a dropped connection it catches up.',
  },
  {
    where: 'Workspace',
    title: 'Your user sees it',
    body: 'The row flashes, a marker stays, and a file that is open reloads in place.',
  },
];

/**
 * How one change travels from the agent to the screen, as four connected steps with a light moving along
 * the wires between them.
 *
 * @example
 * <ChangeFlow />
 */
export function ChangeFlow(): React.JSX.Element {
  return (
    <section aria-labelledby="flow-heading" className="border-y border-fd-border bg-fd-card">
      <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
        <h2 id="flow-heading" className="max-w-[26ch] text-4xl font-bold tracking-tight text-balance">
          How an agent's change reaches your user's screen
        </h2>
        <p className="mt-4 max-w-[60ch] text-lg leading-relaxed text-fd-muted-foreground">
          Live updates work out of the box. If the server refuses the live stream, the browser falls back to
          polling and says so once.
        </p>
        <ol className="mt-12 grid gap-0 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="relative flex gap-4 pb-10 lg:flex-col lg:pr-8 lg:pb-0">
              <div className="flex flex-col items-center lg:flex-row">
                <span className="z-10 grid size-10 shrink-0 place-items-center rounded-full border border-fd-border bg-fd-background font-display text-sm font-semibold">
                  {index + 1}
                </span>
                {index < STEPS.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="wk-wire"
                    style={{ '--wk-wire-delay': `${index * 0.55}s` } as React.CSSProperties}
                  />
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[0.78rem] text-fd-muted-foreground">{step.where}</span>
                <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className="max-w-[34ch] text-sm leading-relaxed text-fd-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
