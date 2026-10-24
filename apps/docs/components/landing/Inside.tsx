import Link from 'next/link';
import { Label, Title } from './Type';

const INCLUDED: readonly { path: string; title: string; body: string }[] = [
  {
    path: 'tree/',
    title: 'A tree that stays fast',
    body: 'Virtualized and keyboard first. A folder of a hundred thousand files scrolls smoothly.',
  },
  {
    path: 'viewers/',
    title: 'Viewers for real files',
    body: 'PDF, Word, PowerPoint, spreadsheets, Markdown, code, images, audio and video, loaded on demand.',
  },
  {
    path: 'live/',
    title: 'Live updates, marked',
    body: 'Files your agent touched carry a marker, and open files reload in place.',
  },
  {
    path: 'upload/',
    title: 'Upload without surprises',
    body: 'Drop files or folders. Large files go up in chunks, and name clashes ask before overwriting.',
  },
  {
    path: 'search/',
    title: 'Search and tabs',
    body: 'Find a file anywhere in the tree and keep several open side by side.',
  },
  {
    path: 'theme/',
    title: 'Yours to style',
    body: 'CSS variables, a class name per part and data attributes for state. Light and dark included.',
  },
];

/**
 * Everything the workspace includes, as a grid of cards named like folders.
 *
 * @example
 * <Inside />
 */
export function Inside(): React.JSX.Element {
  return (
    <section aria-labelledby="inside-heading" className="border-t border-fd-border bg-band">
      <div className="mx-auto w-full max-w-7xl px-5 py-28 sm:px-8">
        <div className="flex flex-col gap-5">
          <Label>/inside</Label>
          <Title
            id="inside-heading"
            lead="Everything a file workspace needs."
            rest="Finished, tested and accessible."
          />
        </div>
        <ul className="wk-reveal-each mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INCLUDED.map((item) => (
            <li key={item.title} className="wk-card flex flex-col gap-3 rounded-xl p-6">
              <span className="font-mono text-[0.8rem] text-fd-muted-foreground">{item.path}</span>
              <h3 className="text-lg text-fd-foreground">{item.title}</h3>
              <p className="text-[0.95rem] leading-relaxed text-fd-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ul>
        <Link
          href="/docs"
          className="mt-10 inline-block text-sm font-medium text-fd-foreground hover:underline"
        >
          Read the documentation <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
