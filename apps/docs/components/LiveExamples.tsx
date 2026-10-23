'use client';
import { createMemoryAdapter } from '@scope/core/memory';
import { logRenderer } from '@scope/example-recipes/customRenderer';
import { sampleFiles } from '@scope/demo-kit';
import {
  allRenderers,
  FileSystemProvider,
  useFileTree,
  Workspace,
  type Action,
  type CanPerform,
  type Components,
} from '@scope/workspace';
import '@scope/workspace/styles.css';
import { useState, type ReactNode } from 'react';

const WORKSPACE_HEIGHT = 360;
type Theme = 'light' | 'dark' | 'system';

function useSampleAdapter(): ReturnType<typeof createMemoryAdapter> {
  const [adapter] = useState(() => createMemoryAdapter({ files: sampleFiles() }));
  return adapter;
}

function Control({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="min-w-24">{label}</span>
      {children}
    </label>
  );
}

/**
 * A workspace with controls for the `--fs-accent`, `--fs-radius` and `--fs-row-height` tokens and the
 * theme, so the effect of the tokens (layer 2) and the theme (layer 1) is visible. The CSS it produces is
 * printed below it.
 *
 * @example
 * ```mdx
 * <TokenPlayground />
 * ```
 */
export function TokenPlayground(): React.JSX.Element {
  const adapter = useSampleAdapter();
  const [accent, setAccent] = useState('#6d28d9');
  const [radius, setRadius] = useState(10);
  const [rowHeight, setRowHeight] = useState(30);
  const [theme, setTheme] = useState<Theme>('system');
  const css = `.brand-workspace {\n  --fs-accent: ${accent};\n  --fs-radius: ${radius}px;\n  --fs-row-height: ${rowHeight}px;\n}`;
  return (
    <div className="not-prose my-4 flex flex-col gap-3" data-testid="token-playground">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Control label="Accent">
          <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} />
        </Control>
        <Control label="Radius">
          <input
            type="range"
            min={0}
            max={20}
            value={radius}
            onChange={(event) => setRadius(Number(event.target.value))}
          />
        </Control>
        <Control label="Row height">
          <input
            type="range"
            min={24}
            max={44}
            value={rowHeight}
            onChange={(event) => setRowHeight(Number(event.target.value))}
          />
        </Control>
        <Control label="Theme">
          <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </Control>
      </div>
      <Workspace
        adapter={adapter}
        theme={theme}
        style={
          {
            height: WORKSPACE_HEIGHT,
            '--fs-accent': accent,
            '--fs-radius': `${radius}px`,
            '--fs-row-height': `${rowHeight}px`,
          } as React.CSSProperties
        }
      />
      <pre data-testid="token-css">
        <code>{css}</code>
      </pre>
    </div>
  );
}

function BrandEmptyState({ children }: { children?: ReactNode }): React.JSX.Element {
  return (
    <div data-brand-empty role="note">
      <strong>Nothing here yet</strong>
      <p>{children}</p>
    </div>
  );
}

const BRAND_COMPONENTS: Components = { EmptyState: BrandEmptyState };
const BRAND_CLASS_NAMES = { 'workspace-files': 'border-e-4 border-fuchsia-600' };

/**
 * An empty workspace whose `EmptyState` slot (layer 5) and `workspace-files` class name (layer 4) can be
 * switched on and off.
 *
 * @example
 * ```mdx
 * <SlotPlayground />
 * ```
 */
export function SlotPlayground(): React.JSX.Element {
  const [adapter] = useState(() => createMemoryAdapter({ files: {} }));
  const [replaced, setReplaced] = useState(true);
  const [classed, setClassed] = useState(true);
  return (
    <div className="not-prose my-4 flex flex-col gap-3" data-testid="slot-playground">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={replaced} onChange={(event) => setReplaced(event.target.checked)} />
          Replace the EmptyState slot
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={classed} onChange={(event) => setClassed(event.target.checked)} />
          Add a class to workspace-files
        </label>
      </div>
      <Workspace
        adapter={adapter}
        components={replaced ? BRAND_COMPONENTS : undefined}
        classNames={classed ? BRAND_CLASS_NAMES : undefined}
        style={{ height: WORKSPACE_HEIGHT }}
      />
    </div>
  );
}

const LOG_LINES = [
  '2026-10-23 09:00:01 INFO  agent started',
  '2026-10-23 09:00:04 DEBUG reading README.md',
  '2026-10-23 09:00:09 WARN  src/index.ts changed on disk',
  '2026-10-23 09:00:12 ERROR could not write data/sales.xlsx',
].join('\n');

const LOG_RENDERERS = [logRenderer(), ...allRenderers()];

/**
 * A workspace holding `run.log`, opened by the custom renderer from the recipes, put first so it wins.
 *
 * @example
 * ```mdx
 * <CustomRendererDemo />
 * ```
 */
export function CustomRendererDemo(): React.JSX.Element {
  const [adapter] = useState(() => createMemoryAdapter({ files: { 'run.log': LOG_LINES } }));
  return (
    <div className="not-prose my-4" data-testid="custom-renderer-demo">
      <Workspace adapter={adapter} renderers={LOG_RENDERERS} style={{ height: WORKSPACE_HEIGHT }} />
    </div>
  );
}

const PROTECTED_PATHS = new Set(['README.md', 'package.json']);
const keepProtectedFilesIntact: CanPerform = (actionId, entry) =>
  !(PROTECTED_PATHS.has(entry.path) && ['delete', 'rename', 'cut'].includes(actionId));

/**
 * A workspace with one custom action ("Ask the agent about this") and a `canPerform` policy that keeps
 * `README.md` and `package.json` from being deleted, renamed or cut. The last action it ran is shown below.
 *
 * @example
 * ```mdx
 * <ActionsDemo />
 * ```
 */
export function ActionsDemo(): React.JSX.Element {
  const adapter = useSampleAdapter();
  const [asked, setAsked] = useState<string | null>(null);
  const [actions] = useState<Action[]>(() => [
    {
      id: 'askAgent',
      label: 'Ask the agent about this',
      group: 'agent',
      when: (entry) => entry.kind === 'file',
      run: (entry) => setAsked(entry.path),
    },
  ]);
  return (
    <div className="not-prose my-4 flex flex-col gap-2" data-testid="actions-demo">
      <Workspace
        adapter={adapter}
        actions={actions}
        canPerform={keepProtectedFilesIntact}
        style={{ height: WORKSPACE_HEIGHT }}
      />
      <p role="status" className="text-sm" data-testid="asked-status">
        {asked === null ? 'Right-click a file to run the custom action.' : `Asked the agent about ${asked}.`}
      </p>
    </div>
  );
}

function PlainTree(): React.JSX.Element {
  const tree = useFileTree();
  const rows = Array.from({ length: tree.index.count }, (_, index) => tree.index.rowAt(index));
  return (
    <div {...tree.getTreeProps()}>
      {rows.map((row) => (
        <div key={row.path} {...tree.getRowProps(row)} style={{ paddingInlineStart: row.depth * 16 }}>
          {row.entry.name}
        </div>
      ))}
    </div>
  );
}

/**
 * The headless tree from layer 7: `useFileTree` supplies the rows and the prop getters, and the markup is
 * plain `div`s with no stylesheet.
 *
 * @example
 * ```mdx
 * <HeadlessTreeDemo />
 * ```
 */
export function HeadlessTreeDemo(): React.JSX.Element {
  const adapter = useSampleAdapter();
  return (
    <div className="not-prose my-4" data-testid="headless-tree-demo">
      <FileSystemProvider adapter={adapter}>
        <PlainTree />
      </FileSystemProvider>
    </div>
  );
}
