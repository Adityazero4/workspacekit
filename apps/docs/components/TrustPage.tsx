import type { ReactNode } from 'react';

/**
 * A plain reading page for the site's About, Contact and Privacy pages: a title, a one-line summary and
 * prose.
 *
 * @example
 * <TrustPage title="About" lead="What workspacekit is.">...</TrustPage>
 */
export function TrustPage(props: { title: string; lead: string; children: ReactNode }): React.JSX.Element {
  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-20 sm:px-8">
      <h1 className="wk-gradient-text text-[clamp(2.4rem,5vw,3.5rem)] leading-[1.05] font-medium tracking-[-0.05em]">
        {props.title}
      </h1>
      <p className="mt-5 text-lg leading-relaxed text-fd-muted-foreground">{props.lead}</p>
      <div className="wk-prose mt-12">{props.children}</div>
    </article>
  );
}
