import { constants, rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FsError } from '@workspacekit/core';
import { docsLink } from '@workspacekit/core/docs';

const SESSIONS_SUBFOLDER = 'workspacekit-uploads';
const MARKER_FILE = '.workspacekit-uploads';
const SESSION_FOLDER_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPEN_FOLDER_WITHOUT_FOLLOWING_LINKS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const foldersToRemoveOnExit = new Set<string>();
const holderOfFolder = new Map<string, object>();

function removeFoldersOnExit(): void {
  for (const folder of foldersToRemoveOnExit) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

function refusedFolder(folder: string, reason: string): FsError {
  return new FsError(
    'unknown',
    `uploadTempDir ${folder} ${reason}. Give each handler its own folder, owned by the server's user with ` +
      `mode 0700. See ${docsLink('server/handler', 'uploadtempdir')}`,
  );
}

async function assertPrivateFolder(folder: string): Promise<void> {
  const handle = await open(folder, OPEN_FOLDER_WITHOUT_FOLLOWING_LINKS).catch(() => {
    throw refusedFolder(folder, 'cannot be opened as a folder (a symlink is refused)');
  });
  try {
    const stats = await handle.stat();
    const userId = process.getuid?.();
    const ownedAndPrivate = userId === undefined || (stats.uid === userId && (stats.mode & 0o777) === 0o700);
    if (!stats.isDirectory() || !ownedAndPrivate) {
      throw refusedFolder(folder, 'must be a folder owned by this user with mode 0700');
    }
  } finally {
    await handle.close();
  }
}

function assertNotHeldByAnother(folder: string, owner: object): void {
  const holder = holderOfFolder.get(folder);
  if (holder !== undefined && holder !== owner) {
    throw refusedFolder(folder, 'is already used by another handler in this process');
  }
}

async function createSessionsSubfolder(sessions: string): Promise<void> {
  await mkdir(sessions, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  });
}

async function assertMarked(sessions: string): Promise<void> {
  const marker = await lstat(join(sessions, MARKER_FILE)).catch(() => null);
  if (marker?.isFile()) return;
  if ((await readdir(sessions)).length > 0) {
    throw refusedFolder(
      sessions,
      `has content but no ${MARKER_FILE} marker, so it was not made by this library`,
    );
  }
  await writeFile(join(sessions, MARKER_FILE), '', { flag: 'wx', mode: 0o600 });
}

async function removeSessionFoldersOlderThan(folder: string, ttlMs: number): Promise<void> {
  const cutoff = Date.now() - ttlMs;
  for (const name of await readdir(folder)) {
    if (!SESSION_FOLDER_NAME.test(name)) continue;
    const stats = await lstat(join(folder, name)).catch(() => null);
    if (stats?.isDirectory() && stats.mtimeMs < cutoff) {
      await rm(join(folder, name), { recursive: true, force: true });
    }
  }
}

/**
 * A new private folder (`mkdtemp`, mode 0700) under the system temp directory, removed on a best-effort basis
 * when the process exits.
 *
 * @example
 * const folder = await freshUploadFolder();
 */
export async function freshUploadFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'workspacekit-uploads-'));
  if (foldersToRemoveOnExit.size === 0) process.once('exit', removeFoldersOnExit);
  foldersToRemoveOnExit.add(folder);
  return folder;
}

/**
 * Prepares the sessions folder inside an integrator's `uploadTempDir`: the `workspacekit-uploads` subfolder,
 * created by this library and carrying a marker file. Both folders are checked through an open handle (a
 * folder, not a link, owned by this user with mode 0700); an existing subfolder with content but no marker
 * is refused, and so is one another handler in this process holds. The sweep removes only session folders
 * a previous run left in the subfolder once they are older than `ttlMs`; nothing else in `uploadTempDir` is
 * ever touched.
 *
 * @example
 * const sessions = await ownedUploadFolder('/var/lib/app/uploads', 3_600_000, uploads);
 */
export async function ownedUploadFolder(folder: string, ttlMs: number, owner: object): Promise<string> {
  const resolved = resolve(folder);
  await assertPrivateFolder(resolved);
  const sessions = join(resolved, SESSIONS_SUBFOLDER);
  assertNotHeldByAnother(sessions, owner);
  await createSessionsSubfolder(sessions);
  await assertPrivateFolder(sessions);
  await assertMarked(sessions);
  await removeSessionFoldersOlderThan(sessions, ttlMs);
  return sessions;
}

/**
 * Marks `folder` as used by `owner`, which holds unfinished uploads in it; throws when another owner in this
 * process already does.
 *
 * @example
 * claimUploadFolder(folder, uploads);
 */
export function claimUploadFolder(folder: string, owner: object): void {
  assertNotHeldByAnother(folder, owner);
  holderOfFolder.set(folder, owner);
}

/**
 * Lets other handlers use `folder` again, once `owner` holds no unfinished uploads in it.
 *
 * @example
 * releaseUploadFolder(folder, uploads);
 */
export function releaseUploadFolder(folder: string, owner: object): void {
  if (holderOfFolder.get(folder) === owner) holderOfFolder.delete(folder);
}
