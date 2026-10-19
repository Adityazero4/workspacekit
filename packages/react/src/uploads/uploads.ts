'use client';
import {
  createUploader,
  expandDropped,
  FsError,
  toFsError,
  type DroppedItem,
  type FileSystemAdapter,
  type ConflictChoice,
  type Entry,
  type TreeStore,
  type UploadItem,
  type UploadOptions,
  type UploadProgress,
  type UploadResult,
  type Uploader,
} from '@scope/core';
import { entryOnTheServer } from '../actions/serverEntry';
import { isUnchangedSince, replaceRefusedMessage, type ConflictQueue } from '../dialogs/conflicts';
import { useUiValue, type Notice } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { createUiStore, type UiStore } from '../provider/ui-store';

/**
 * One upload run: the files of one drop or one file-picker selection, uploaded into `targetDir`.
 *
 * @example
 * ```ts
 * const running = runs.filter((run: UploadRun) => run.status === 'running');
 * ```
 */
export interface UploadRun {
  id: string;
  targetDir: string;
  /**
   * The names of the dropped or picked top-level files and folders; the tree shows a placeholder for each.
   */
  topLevelNames: readonly string[];
  progress: UploadProgress;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  result?: UploadResult;
  /** Aborts the run; the files it already created are deleted, files that were there before are kept. */
  cancel: () => void;
}

/**
 * What `useUploads` returns.
 *
 * @example
 * ```ts
 * const { runs, upload, dismiss }: UploadsApi = useUploads();
 * ```
 */
export interface UploadsApi {
  runs: readonly UploadRun[];
  /**
   * Expands dropped folders (skipping OS and tooling junk such as `node_modules`), then uploads every file
   * into `targetDir`. More than 500 files upload nothing and post a notice. A file whose name is taken is
   * handled as the provider's `onUploadConflict` says; by default a mounted tree asks. Rejects only when the
   * adapter has no `upload`.
   */
  upload: (items: DroppedItem[] | UploadItem[], targetDir: string) => Promise<UploadResult>;
  /** Removes a finished run from `runs`. */
  dismiss: (id: string) => void;
}

/**
 * The provider's upload state, one per workspace session; `useUploads` reads it.
 *
 * @internal
 * @example
 * ```ts
 * const { uploads } = useFileSystemInternals();
 * uploads.runs.subscribe(() => render(uploads.runs.get()));
 * ```
 */
export interface UploadsController {
  runs: UiStore<readonly UploadRun[]>;
  /** The latest upload announcement (a run started, finished, failed or was cancelled), for a live region. */
  announcement: UiStore<string>;
  upload: UploadsApi['upload'];
  dismiss: UploadsApi['dismiss'];
  /** Cancels every running upload and stops reporting; the provider calls it when its session ends. */
  cancelAll: () => void;
}

/**
 * What `createUploads` needs.
 *
 * @example
 * ```ts
 * const options: UploadsOptions = {
 *   adapter,
 *   store,
 *   notify,
 *   report,
 *   conflictPolicy: () => 'keepBoth',
 *   conflicts,
 * };
 * ```
 */
export interface UploadsOptions {
  adapter: FileSystemAdapter;
  store: TreeStore;
  notify: (notice: Notice) => void;
  /** Receives the error of every file that failed to upload. */
  report: (error: FsError) => void;
  /**
   * Read at the start of every run, so the latest provider prop applies; `undefined` asks through
   * `conflicts`.
   */
  conflictPolicy: () => UploadOptions['onConflict'];
  conflicts: ConflictQueue;
}

const MAX_FILES_PER_UPLOAD = 500;
const MAX_SKIPPED_NAMES_SHOWN = 3;
const NOTHING_UPLOADED: UploadResult = { uploaded: [], skipped: [], failed: [], cancelled: false };
const ignoreFailure = (): void => undefined;

const countOfFiles = (count: number): string => (count === 1 ? '1 file' : `${count} files`);
const folderLabel = (targetDir: string): string => (targetDir === '' ? 'the root folder' : `"${targetDir}"`);
const topLevelNameOf = (item: UploadItem): string => item.relativePath.split('/')[0]!;

function uploaderFor(adapter: FileSystemAdapter): Uploader | null {
  const transport = adapter.upload;
  if (!transport) return null;
  return createUploader({
    transport,
    exists: async (path) => (await entryOnTheServer(adapter, path)) !== null,
    remove: (path) =>
      adapter.delete
        ? adapter.delete(path)
        : Promise.reject(
            new FsError(
              'invalid',
              'the adapter cannot delete files; give it a `delete` so a cancelled upload can remove its files',
            ),
          ),
  });
}

interface ConflictRun {
  adapter: FileSystemAdapter;
  conflicts: ConflictQueue;
  notify: (notice: Notice) => void;
  signal: AbortSignal;
  fileCount: number;
  filesNotDone: () => number;
}

function askOncePerRun(run: ConflictRun): (path: string) => Promise<ConflictChoice> {
  const { adapter, conflicts } = run;
  let choiceForAll: ConflictChoice | null = null;
  let previousQuestion: Promise<unknown> = Promise.resolve();
  let questionsAsked = 0;
  const replaceIfStillUnchanged = async (path: string, seen: Entry | undefined): Promise<ConflictChoice> => {
    const current = seen && (await entryOnTheServer(adapter, path).catch(() => undefined));
    if (seen && isUnchangedSince(seen, current)) return 'replace';
    run.notify({
      kind: 'error',
      message: replaceRefusedMessage(path, seen, 'it was not replaced and the file was skipped'),
    });
    return 'skip';
  };
  const ask = async (path: string): Promise<ConflictChoice> => {
    if (run.signal.aborted) return 'skip';
    if (!choiceForAll && conflicts.hosts.get().length === 0) return 'keepBoth';
    const existing = (await entryOnTheServer(adapter, path)) ?? undefined;
    const canReplace = existing?.kind !== 'directory';
    if (choiceForAll && (choiceForAll !== 'replace' || canReplace)) return choiceForAll;
    const filesNotAskedAbout = run.fileCount - questionsAsked++;
    const remaining = Math.min(run.filesNotDone(), filesNotAskedAbout) - 1;
    const answer = await conflicts.ask('upload', path, { remaining, existing, incoming: 'file' });
    if (!answer) return 'skip';
    if (answer.applyToAll) choiceForAll = answer.choice;
    if (answer.choice === 'replace') return replaceIfStillUnchanged(path, existing);
    return answer.choice;
  };
  return (path) => {
    const question = previousQuestion.then(() => ask(path));
    previousQuestion = question;
    return question;
  };
}

function finishedStatus(result: UploadResult): UploadRun['status'] {
  if (result.cancelled) return 'cancelled';
  return result.failed.length > 0 ? 'failed' : 'done';
}

function nothingToUploadNotice(skipped: readonly string[]): Notice {
  const named = skipped.slice(0, MAX_SKIPPED_NAMES_SHOWN).join(', ');
  const others = skipped.length - MAX_SKIPPED_NAMES_SHOWN;
  return {
    kind: 'info',
    message: `Nothing was uploaded: ${named}${others > 0 ? ` and ${others} more` : ''} skipped as system or tooling files.`,
  };
}

function finishedNotice(run: UploadRun, result: UploadResult): Notice {
  const target = folderLabel(run.targetDir);
  const firstFailure = result.failed[0];
  if (result.cancelled) return { kind: 'info', message: `Upload to ${target} cancelled.` };
  if (firstFailure) {
    return {
      kind: 'error',
      message: `${result.failed.length} of ${countOfFiles(run.progress.total)} failed to upload to ${target}.`,
    };
  }
  return { kind: 'success', message: `Uploaded ${countOfFiles(result.uploaded.length)} to ${target}.` };
}

/**
 * The upload state of one workspace session: an uploader over `adapter.upload`, the runs with their progress,
 * and the announcements. A finished run reloads its target folder before it stops counting as running, so its
 * placeholders give way to the uploaded entries without a gap. Every failed file's error goes to `report`;
 * one notice sums them up.
 *
 * @internal
 *
 * @example
 * ```ts
 * const uploads = createUploads({ adapter, store, notify, report, conflictPolicy: () => undefined });
 * await uploads.upload(fromFileList(input.files!), 'inbox');
 * ```
 */
export function createUploads(options: UploadsOptions): UploadsController {
  const { adapter, store, notify, report } = options;
  const uploader = uploaderFor(adapter);
  const runs = createUiStore<readonly UploadRun[]>([]);
  const announcement = createUiStore('');
  const controllers = new Set<AbortController>();
  let lastRunNumber = 0;
  let sessionEnded = false;

  const updateRun = (id: string, change: Partial<UploadRun>): void =>
    runs.set((previous) => previous.map((run) => (run.id === id ? { ...run, ...change } : run)));
  const runWithId = (id: string): UploadRun => runs.get().find((run) => run.id === id)!;

  const startRun = (items: UploadItem[], targetDir: string, abort: AbortController): UploadRun => {
    const run: UploadRun = {
      id: `upload-${++lastRunNumber}`,
      targetDir,
      topLevelNames: [...new Set(items.map(topLevelNameOf))],
      progress: {
        loadedBytes: 0,
        totalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
        done: 0,
        total: items.length,
      },
      status: 'running',
      cancel: () => abort.abort(),
    };
    runs.set((previous) => [...previous, run]);
    announcement.set(`Uploading ${countOfFiles(items.length)} to ${folderLabel(targetDir)}.`);
    return run;
  };

  const announce = (notice: Notice): void => {
    announcement.set(notice.message);
    notify(notice);
  };

  const finishRun = async (id: string, result: UploadResult): Promise<void> => {
    const finished = { status: finishedStatus(result), result };
    if (!sessionEnded) await store.loadFolder(runWithId(id).targetDir, { force: true }).catch(ignoreFailure);
    updateRun(id, finished);
    if (sessionEnded) return;
    announce(finishedNotice(runWithId(id), result));
    for (const failure of result.failed) report(failure.error);
  };

  const uploadExpanded = async (
    activeUploader: Uploader,
    items: UploadItem[],
    targetDir: string,
  ): Promise<UploadResult> => {
    const abort = new AbortController();
    controllers.add(abort);
    const { id } = startRun(items, targetDir, abort);
    const filesNotDone = (): number => {
      const { total, done } = runWithId(id).progress;
      return total - done;
    };
    const result = await activeUploader
      .upload(items, targetDir, {
        onConflict:
          options.conflictPolicy() ??
          askOncePerRun({
            adapter,
            conflicts: options.conflicts,
            notify,
            signal: abort.signal,
            fileCount: items.length,
            filesNotDone,
          }),
        signal: abort.signal,
        onProgress: (progress) => updateRun(id, { progress }),
      })
      .catch((error: unknown): UploadResult => ({
        ...NOTHING_UPLOADED,
        failed: [{ path: targetDir, error: toFsError(error) }],
        cancelled: abort.signal.aborted,
      }));
    controllers.delete(abort);
    await finishRun(id, result);
    return result;
  };

  return {
    runs,
    announcement,
    upload: async (items, targetDir) => {
      if (!uploader) {
        throw new FsError(
          'invalid',
          'the adapter has no upload transport; give the adapter an `upload` to enable uploads',
        );
      }
      const expanded = await expandDropped(items, { maxFiles: MAX_FILES_PER_UPLOAD });
      if (expanded.overLimit) {
        announce({
          kind: 'error',
          message: `That is more than ${MAX_FILES_PER_UPLOAD} files, so nothing was uploaded. Upload fewer files at a time.`,
        });
        return NOTHING_UPLOADED;
      }
      if (expanded.items.length === 0) {
        if (expanded.skipped.length > 0) announce(nothingToUploadNotice(expanded.skipped));
        return { ...NOTHING_UPLOADED, skipped: expanded.skipped };
      }
      return uploadExpanded(uploader, expanded.items, targetDir);
    },
    dismiss: (id) =>
      runs.set((previous) => previous.filter((run) => run.id !== id || run.status === 'running')),
    cancelAll: () => {
      sessionEnded = true;
      for (const abort of controllers) abort.abort();
    },
  };
}

/**
 * The upload runs of the nearest `FileSystemProvider`, plus `upload` and `dismiss`. Re-renders when a run
 * starts, progresses or finishes.
 *
 * @example
 * ```tsx
 * const { runs, upload } = useUploads();
 * <input
 *   type="file"
 *   multiple
 *   onChange={(event) => void upload(fromFileList(event.currentTarget.files!), 'inbox')}
 * />
 * ```
 */
export function useUploads(): UploadsApi {
  const { uploads } = useFileSystemInternals();
  const runs = useUiValue(uploads.runs);
  return { runs, upload: uploads.upload, dismiss: uploads.dismiss };
}
