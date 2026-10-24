'use client';
import { FsError, type Entry, type FileSystemAdapter } from '@workspacekit/core';
import { safeUrlOrNull } from '../renderers/safeUrls';

const DOWNLOAD_URL_LIFETIME_MS = 40_000;

function clickDownloadLink(href: string, fileName: string, opensElsewhere: boolean): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  if (opensElsewhere) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  document.body.append(link);
  link.click();
  link.remove();
}

function safeDownloadUrl(url: string): string {
  const safe = safeUrlOrNull(url);
  if (safe === null) {
    throw new FsError(
      'invalid',
      `the adapter returned the download URL "${url}", which is not an http, https or blob URL; return one of those`,
    );
  }
  return safe;
}

/**
 * Downloads `url` under `fileName` through an `<a download>` that opens in a new tab when the browser ignores
 * `download` (a cross-origin URL). Throws `FsError` `invalid` for a URL that is not http, https or blob, so
 * an adapter cannot make a download run script.
 *
 * @example
 * ```ts
 * downloadUrl('https://files.example/report.pdf', 'report.pdf');
 * ```
 */
export function downloadUrl(url: string, fileName: string): void {
  clickDownloadLink(safeDownloadUrl(url), fileName, true);
}

/**
 * Downloads `entry` with `adapter.download`, which must exist: a returned URL goes through `downloadUrl`, a
 * returned `Blob` is saved under the entry's name (`<name>.zip` for a folder).
 *
 * @example
 * ```ts
 * if (adapter.download) await downloadEntry(adapter, entry);
 * ```
 */
export async function downloadEntry(adapter: FileSystemAdapter, entry: Entry): Promise<void> {
  const result = await adapter.download!([entry.path]);
  if (!(result instanceof Blob)) {
    downloadUrl(result.url, result.fileName ?? entry.name);
    return;
  }
  const url = URL.createObjectURL(result);
  clickDownloadLink(url, entry.kind === 'directory' ? `${entry.name}.zip` : entry.name, false);
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}
