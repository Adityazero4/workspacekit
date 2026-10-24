const TREE_ROWS: readonly { name: string; depth: number; isAgent?: boolean; isFolder?: boolean }[] = [
  { name: 'reports', depth: 0, isFolder: true },
  { name: 'q3-summary.pdf', depth: 1 },
  { name: 'forecast.xlsx', depth: 1, isAgent: true },
  { name: 'notes', depth: 0, isFolder: true },
  { name: 'plan.md', depth: 1, isAgent: true },
  { name: 'kickoff.pptx', depth: 1 },
  { name: 'src', depth: 0, isFolder: true },
  { name: 'agent.ts', depth: 1 },
  { name: 'tools.ts', depth: 1, isAgent: true },
  { name: 'README.md', depth: 0 },
];

const FORMATS: readonly string[] = ['PDF', 'DOCX', 'PPTX', 'XLSX', 'CSV', 'MD', 'TS', 'PNG', 'MP4', 'MP3'];

const KEYS: readonly { keys: string; does: string }[] = [
  { keys: '↑ ↓', does: 'move' },
  { keys: '→ ←', does: 'open or close a folder' },
  { keys: 'Enter', does: 'open the file' },
  { keys: 'F2', does: 'rename' },
];

function Cell(props: {
  title: string;
  body: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      className={`flex flex-col gap-4 rounded-2xl border border-fd-border bg-fd-card p-5 ${props.className ?? ''}`}
    >
      <div className="flex-1">{props.children}</div>
      <div>
        <h3 className="text-lg font-semibold tracking-tight">{props.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-fd-muted-foreground">{props.body}</p>
      </div>
    </li>
  );
}

function TreeMock(): React.JSX.Element {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-0.5 font-mono text-[0.8rem]">
      {TREE_ROWS.map((row) => (
        <li
          key={row.name}
          style={{ paddingLeft: `${row.depth * 1.1 + 0.5}rem` }}
          className={`flex items-center justify-between rounded py-1 pr-2 ${row.isAgent ? 'bg-amber-soft text-fd-foreground' : 'text-fd-muted-foreground'}`}
        >
          <span>{row.isFolder ? `${row.name}/` : row.name}</span>
          {row.isAgent ? <span className="size-1.5 rounded-full bg-amber" /> : null}
        </li>
      ))}
    </ul>
  );
}

function UploadMock(): React.JSX.Element {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-3 font-mono text-[0.78rem] text-fd-muted-foreground">
      {[
        { name: 'contract.docx', done: 100 },
        { name: 'dataset.csv', done: 62 },
        { name: 'deck.pptx', done: 18 },
      ].map((file) => (
        <li key={file.name} className="flex flex-col gap-1">
          <span>{file.name}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-fd-muted">
            <span className="block h-full rounded-full bg-blue" style={{ width: `${file.done}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function FormatsMock(): React.JSX.Element {
  return (
    <ul aria-hidden="true" className="flex flex-wrap gap-2">
      {FORMATS.map((format) => (
        <li key={format} className="rounded-md border border-fd-border px-2 py-1 font-mono text-[0.78rem]">
          {format}
        </li>
      ))}
    </ul>
  );
}

function KeysMock(): React.JSX.Element {
  return (
    <dl aria-hidden="true" className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
      {KEYS.map((key) => (
        <div key={key.keys} className="contents">
          <dt>
            <kbd className="rounded border border-fd-border bg-fd-muted px-1.5 py-0.5 font-mono text-[0.75rem]">
              {key.keys}
            </kbd>
          </dt>
          <dd className="text-fd-muted-foreground">{key.does}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Everything the workspace includes, as a grid whose cells show a small piece of the real UI.
 *
 * @example
 * <Inside />
 */
export function Inside(): React.JSX.Element {
  return (
    <section aria-labelledby="inside-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
      <h2 id="inside-heading" className="max-w-[24ch] text-4xl font-bold tracking-tight text-balance">
        Everything a file workspace needs, in one component
      </h2>
      <ul className="mt-10 grid gap-4 md:grid-cols-6">
        <Cell
          className="md:col-span-3 md:row-span-2"
          title="A tree that shows who changed what"
          body="Virtualized, so a folder of a hundred thousand files scrolls smoothly. Files your agent touched carry a marker."
        >
          <TreeMock />
        </Cell>
        <Cell
          className="md:col-span-3"
          title="Open the files people actually send"
          body="PDF, Word, PowerPoint, spreadsheets, Markdown, code, images, audio and video, each lazy-loaded."
        >
          <FormatsMock />
        </Cell>
        <Cell
          className="md:col-span-3"
          title="Upload without surprises"
          body="Drop files or folders. Large files go up in chunks, and name clashes ask before overwriting."
        >
          <UploadMock />
        </Cell>
        <Cell
          className="md:col-span-2"
          title="Search and tabs"
          body="Find a file anywhere in the tree and keep several open side by side."
        >
          <div aria-hidden="true" className="flex flex-col gap-2 font-mono text-[0.8rem]">
            <p className="rounded-lg border border-fd-border px-3 py-2 text-fd-foreground">forecast</p>
            <p className="px-3 text-fd-muted-foreground">reports/forecast.xlsx</p>
            <p className="px-3 text-fd-muted-foreground">notes/forecast-notes.md</p>
          </div>
        </Cell>
        <Cell
          className="md:col-span-2"
          title="Keyboard first"
          body="A WAI-ARIA tree with full keyboard control, and progress that screen readers announce."
        >
          <KeysMock />
        </Cell>
        <Cell
          className="md:col-span-2"
          title="Yours to style"
          body="CSS variables, class names per part and data attributes for state. Light and dark included."
        >
          <p aria-hidden="true" className="font-mono text-[0.8rem] text-fd-muted-foreground">
            --fs-accent: #2563eb;
            <br />
            --fs-flash: #fde68a;
          </p>
        </Cell>
      </ul>
    </section>
  );
}
