'use client';
import { parentPath, toFsError, type Entry, type FileSystemAdapter } from '@workspacekit/core';

/**
 * The entry at `path` as the server reports it right now, bypassing the tree store (whose listing may be
 * stale), or `null` when nothing is there. Uses `adapter.stat` when the adapter has it, and a depth-1 listing
 * of the parent otherwise. Rejects when the server cannot be read.
 *
 * @example
 * ```ts
 * const current = await entryOnTheServer(adapter, 'docs/a.txt');
 * ```
 */
export async function entryOnTheServer(adapter: FileSystemAdapter, path: string): Promise<Entry | null> {
  if (adapter.stat) return adapter.stat(path);
  try {
    const siblings = await adapter.list(parentPath(path), { depth: 1 });
    return siblings.find((entry) => entry.path === path) ?? null;
  } catch (error) {
    if (toFsError(error).kind === 'not_found') return null;
    throw error;
  }
}
