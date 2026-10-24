import type { FileSystemAdapter } from '@workspacekit/core';
import { Workspace, type Components } from '@workspacekit/react';
import '@workspacekit/react/styles.css';
import './theming.css';

function BrandEmptyState({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div data-brand-empty>
      <strong>Nothing here yet</strong>
      <p>{children}</p>
    </div>
  );
}

const COMPONENTS: Components = { EmptyState: BrandEmptyState };
const CLASS_NAMES = { 'workspace-files': 'brand-files' };

/**
 * Props of `ThemedWorkspace`: the adapter to show and the theme. `'system'` follows `prefers-color-scheme`;
 * `'light'` and `'dark'` set `data-theme` on the workspace.
 *
 * @example
 * const props: ThemedWorkspaceProps = { adapter, theme: 'dark' };
 */
export interface ThemedWorkspaceProps {
  adapter: FileSystemAdapter;
  theme?: 'light' | 'dark' | 'system';
}

/**
 * A `Workspace` restyled in the four layers of the styling contract: tokens (`--fs-accent`, `--fs-radius`,
 * `--fs-row-height`, `--fs-font`, with a dark value) in `theming.css`, a class on one part through
 * `classNames`, one replaced slot (`components.EmptyState`), and light/dark through `theme`.
 *
 * @example
 * <ThemedWorkspace adapter={httpAdapter('/api/files')} theme="system" />
 */
export function ThemedWorkspace({ adapter, theme = 'system' }: ThemedWorkspaceProps): React.JSX.Element {
  return (
    <Workspace
      adapter={adapter}
      theme={theme}
      className="brand-workspace"
      classNames={CLASS_NAMES}
      components={COMPONENTS}
      style={{ height: 480 }}
    />
  );
}
