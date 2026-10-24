import type { ReactNode } from 'react';

/**
 * A section label written as a path, the way the workspace names folders.
 *
 * @example
 * <Label>/how-it-works</Label>
 */
export function Label(props: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="wk-path">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5">
        <path
          d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5H13c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      {props.children}
    </p>
  );
}

/**
 * A two-tone section title: the statement in full strength, the rest of the sentence muted.
 *
 * @example
 * <Title id="flow-heading" lead="From your agent's write" rest="to your user's screen." />
 */
export function Title(props: {
  id: string;
  lead: string;
  rest: string;
  className?: string;
}): React.JSX.Element {
  return (
    <h2
      id={props.id}
      className={`max-w-[24ch] text-[clamp(2rem,4vw,3rem)] leading-[1.08] text-fd-foreground ${props.className ?? ''}`}
    >
      {props.lead} <span className="wk-muted-phrase">{props.rest}</span>
    </h2>
  );
}
