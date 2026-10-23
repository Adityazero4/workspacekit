import { Workspace as WorkspaceShell, type WorkspaceProps } from '@scope/react';
import { allRenderers } from './allRenderers';

const everyRenderer = allRenderers();

/**
 * `@scope/react`'s `Workspace` with every renderer installed: `renderers` defaults to `allRenderers()`, and a
 * `renderers` you pass still wins. All other props are the same.
 *
 * @example
 * ```tsx
 * export default function Files(): React.JSX.Element {
 *   return <Workspace adapter={httpAdapter('/api/files')} />;
 * }
 * ```
 */
export function Workspace(props: WorkspaceProps): React.JSX.Element {
  return <WorkspaceShell {...props} renderers={props.renderers ?? everyRenderer} />;
}
