'use client';
import { useEffect, useState } from 'react';

const RESET_AFTER_MS = 2000;

/**
 * A button that copies `text` to the clipboard and says whether that worked for two seconds.
 *
 * @example
 * ```tsx
 * <CopyButton text="pnpm add @workspacekit/workspace" label="Copy the install command" />
 * ```
 */
export function CopyButton(props: { text: string; label: string }): React.JSX.Element {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), RESET_AFTER_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text);
      setOutcome('copied');
    } catch {
      setOutcome('failed');
    }
  };
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={() => void copy()}
      className="rounded-md border border-fd-border px-2 py-1 text-xs font-medium text-fd-foreground hover:bg-fd-accent"
    >
      {outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
