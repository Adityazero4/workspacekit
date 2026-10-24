import {
  entryAt,
  FsError,
  isSameOrDescendant,
  normalizePath,
  parentPath,
  statusOf,
  type TreeStore,
} from '@workspacekit/core';
import { withMembership, type UiStore } from './ui-store';

/**
 * Options of `reveal`.
 *
 * @example
 * ```ts
 * const options: RevealOptions = { flash: true };
 * ```
 */
export interface RevealOptions {
  /**
   * Mark the revealed row with `data-flash` for `--fs-flash-duration` (1.5 s by default). Default `false`.
   */
  flash?: boolean;
  /** When the entry is a folder, expand it too. Default `false`. */
  expand?: boolean;
  /**
   * Focus the revealed row. Default `true`. With `false` the row is scrolled into view (and flashed) but
   * focus stays where it is, for a reveal the user did not ask for, such as following an agent's changes.
   */
  focus?: boolean;
}

/**
 * Shows an entry in the tree; see `FileSystemContext.reveal`. A later call replaces an earlier one, which
 * then rejects with `FsError` `cancelled`; treat that as "nothing to do".
 *
 * @example
 * ```ts
 * const reveal: Reveal = useFileSystem().reveal;
 * reveal('src/index.ts', { flash: true }).catch((error: unknown) => {
 *   if (toFsError(error).kind !== 'cancelled') showError(error);
 * });
 * ```
 */
export type Reveal = (path: string, opts?: RevealOptions) => Promise<void>;

/**
 * A mounted tree that can show a revealed row: scroll it into view, focus it (even when focus is outside the
 * tree) unless `focus` is `false`, and flash it.
 *
 * @internal
 * @example
 * ```ts
 * const detach = attachRevealHost({ show: (path, { flash, focus }) => showRow(path, flash, focus) });
 * ```
 */
export interface RevealHost {
  show: (path: string, opts: { flash: boolean; focus: boolean }) => void;
}

interface RevealerParts {
  store: TreeStore;
  root: string;
  expanded: UiStore<ReadonlySet<string>>;
  selected: UiStore<string | null>;
}

/**
 * The folders strictly between `root` and `path`, top-down; for a `path` outside `root`, every folder above
 * it.
 *
 * @example
 * ```ts
 * foldersBetween('', 'src/app/main.ts'); // ['src', 'src/app']
 * ```
 */
export function foldersBetween(root: string, path: string): string[] {
  const folders: string[] = [];
  let folder = parentPath(path);
  while (folder !== root && folder !== '') {
    folders.unshift(folder);
    folder = parentPath(folder);
  }
  return folders;
}

const notFound = (path: string, missing: string): FsError =>
  new FsError(
    'not_found',
    `Cannot reveal "${path}": "${missing}" does not exist. Check the path, or search again if it was moved or deleted.`,
    { path },
  );

const outsideRoot = (path: string, root: string): FsError =>
  new FsError(
    'invalid',
    `Cannot reveal "${path}": it is not inside the provider root "${root}". Pass the path of an entry below the root.`,
    { path },
  );

const superseded = (path: string): FsError =>
  new FsError('cancelled', `The reveal of "${path}" was replaced by a later reveal.`, { path });

function normalizedPathBelowRoot(path: string, root: string): string {
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch (error) {
    throw new FsError('invalid', `Cannot reveal "${path}": not a valid path.`, { path, cause: error });
  }
  if (normalized === root || !isSameOrDescendant(normalized, root)) throw outsideRoot(normalized, root);
  return normalized;
}

function hasChildOrThrowLoadError(store: TreeStore, folder: string, child: string): boolean {
  const snapshot = store.getSnapshot();
  const loadError = snapshot.errors.get(folder);
  if (loadError) throw loadError;
  return Boolean(entryAt(snapshot.tree, child));
}

async function loadFolderAndFind(
  store: TreeStore,
  folder: string,
  child: string,
  target: string,
): Promise<void> {
  const wasLoadedBefore = statusOf(store.getSnapshot().tree, folder) === 'loaded';
  await store.loadFolder(folder);
  if (hasChildOrThrowLoadError(store, folder, child)) return;
  if (wasLoadedBefore) {
    await store.loadFolder(folder, { force: true });
    if (hasChildOrThrowLoadError(store, folder, child)) return;
  }
  throw notFound(target, child);
}

function showRevealed(
  parts: RevealerParts,
  host: RevealHost | undefined,
  revealed: { target: string; folders: readonly string[]; opts: RevealOptions | undefined },
): void {
  const { store, expanded, selected } = parts;
  const { target, folders, opts } = revealed;
  const expandTargetToo =
    opts?.expand === true && entryAt(store.getSnapshot().tree, target)?.kind === 'directory';
  expanded.set((previous) =>
    withMembership(previous, expandTargetToo ? [...folders, target] : folders, true),
  );
  selected.set(target);
  store.markSeen(target);
  host?.show(target, { flash: opts?.flash === true, focus: opts?.focus !== false });
}

/**
 * The provider's `reveal` and the registry of trees that show revealed rows (the first mounted one does).
 *
 * @internal
 * @example
 * ```ts
 * const revealer = createRevealer({ store, root: '', expanded, selected });
 * await revealer.reveal('src/index.ts');
 * ```
 */
export function createRevealer(parts: RevealerParts): {
  reveal: Reveal;
  isRevealing: () => boolean;
  attachHost: (host: RevealHost) => () => void;
} {
  const { store, root } = parts;
  const hosts: RevealHost[] = [];
  let latestReveal = 0;
  let latestRevealInFlight = false;

  const revealInOrder = async (
    target: string,
    opts: RevealOptions | undefined,
    revealId: number,
  ): Promise<void> => {
    const isStillTheLatest = (): boolean => revealId === latestReveal;
    const folders = foldersBetween(root, target);
    const toLoad = [root, ...folders];
    for (const [step, folder] of toLoad.entries()) {
      await loadFolderAndFind(store, folder, toLoad[step + 1] ?? target, target).catch((error: unknown) => {
        throw isStillTheLatest() ? error : superseded(target);
      });
      if (!isStillTheLatest()) throw superseded(target);
    }
    showRevealed(parts, hosts[0], { target, folders, opts });
  };

  const reveal: Reveal = async (path, opts) => {
    const target = normalizedPathBelowRoot(path, root);
    const revealId = ++latestReveal;
    latestRevealInFlight = true;
    try {
      await revealInOrder(target, opts, revealId);
    } finally {
      if (revealId === latestReveal) latestRevealInFlight = false;
    }
  };

  return {
    reveal,
    isRevealing: () => latestRevealInFlight,
    attachHost: (host) => {
      hosts.push(host);
      return () => {
        const at = hosts.indexOf(host);
        if (at >= 0) hosts.splice(at, 1);
      };
    },
  };
}
