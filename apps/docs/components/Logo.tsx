/**
 * The workspacekit mark: three stacked sheets, the front one with a live dot, beside the name.
 *
 * @example
 * <Logo />
 */
export function Logo(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[22px]">
        <defs>
          <linearGradient id="wk-logo-dot" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff5e62" />
            <stop offset="1" stopColor="#ff9966" />
          </linearGradient>
        </defs>
        <rect x="7" y="2.5" width="13" height="15" rx="2.5" fill="currentColor" opacity="0.18" />
        <rect x="5" y="4.5" width="13" height="15" rx="2.5" fill="currentColor" opacity="0.38" />
        <rect x="3" y="6.5" width="13" height="15" rx="2.5" fill="currentColor" />
        <circle
          cx="18.5"
          cy="19"
          r="3.5"
          fill="url(#wk-logo-dot)"
          stroke="var(--color-fd-background)"
          strokeWidth="1.5"
        />
      </svg>
      <span className="text-[1.02rem] font-semibold tracking-[-0.03em]">workspacekit</span>
    </span>
  );
}
