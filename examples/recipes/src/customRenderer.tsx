import { defineRenderer, MATCH_SCORE, type Renderer, type RendererProps } from '@scope/react/renderer-kit';

const LEVEL_PATTERN = /\b(ERROR|WARN|INFO|DEBUG)\b/;

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'var(--fs-danger)',
  WARN: 'var(--fs-changed)',
  INFO: 'var(--fs-fg)',
  DEBUG: 'var(--fs-muted)',
};

function LogLine({ line }: { line: string }): React.JSX.Element {
  const level = LEVEL_PATTERN.exec(line)?.[1] ?? 'INFO';
  return (
    <span data-log-level={level.toLowerCase()} style={{ display: 'block', color: LEVEL_COLORS[level] }}>
      {level === 'ERROR' ? <strong>{line}</strong> : line}
    </span>
  );
}

function LogViewer({ source }: RendererProps): React.JSX.Element {
  const lines = source.kind === 'text' ? source.text.split('\n') : [];
  return (
    <pre
      role="region"
      tabIndex={0}
      aria-label="Log file"
      style={{ margin: 0, padding: 12, overflow: 'auto' }}
    >
      {lines.map((line, index) => (
        <LogLine key={index} line={line} />
      ))}
    </pre>
  );
}

/**
 * A renderer for `.log` files that colors each line by its level (`ERROR`, `WARN`, `INFO`, `DEBUG`) with the
 * `--fs-*` tokens. It scores `specific`, so it beats the built-in text renderer, which scores `text`.
 *
 * @example
 * import { lightRenderers, Workspace } from '@scope/react';
 *
 * <Workspace adapter={adapter} renderers={[logRenderer(), ...lightRenderers]} />
 */
export function logRenderer(): Renderer {
  return LOG_RENDERER;
}

const LOG_RENDERER: Renderer = defineRenderer({
  id: 'log',
  match: (file) => file.kind === 'file' && file.extension === 'log' && MATCH_SCORE.specific,
  load: () => Promise.resolve({ default: LogViewer }),
  input: 'text',
  maxBytes: 5 * 1024 * 1024,
});
