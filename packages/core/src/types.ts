export type EntryKind = 'file' | 'directory';
export interface Entry {
  path: string;
  name: string;
  kind: EntryKind;
  size?: number | null;
  mtimeMs?: number;
  meta?: Record<string, unknown>;
}
export interface ChangeEvent {
  /** `resync` (with `path` `''`): changes were missed; the client must reload every loaded folder. */
  type: 'created' | 'updated' | 'deleted' | 'moved' | 'resync';
  path: string;
  oldPath?: string;
  mtimeMs?: number;
  actor?: string;
}
export interface CallOptions {
  signal?: AbortSignal;
}
export interface TransferOptions {
  overwrite?: boolean;
}
export interface UploadTransport {
  direct(
    targetPath: string,
    file: Blob,
    opts: { signal: AbortSignal; onProgress?(loaded: number): void; overwrite?: boolean },
  ): Promise<Entry>;
  chunked?: {
    init(
      targetPath: string,
      totalBytes: number,
      opts?: { overwrite?: boolean },
    ): Promise<{ uploadId: string; chunkSize: number }>;
    put(uploadId: string, index: number, offset: number, data: Blob, signal: AbortSignal): Promise<void>;
    complete(uploadId: string): Promise<Entry>;
    abort(uploadId: string): Promise<void>;
  };
}
export interface FileSystemAdapter {
  list(path: string, opts: { depth: number } & CallOptions): Promise<Entry[]>;
  read(path: string, as: 'text', opts?: CallOptions): Promise<string>;
  read(path: string, as: 'blob', opts?: CallOptions): Promise<Blob>;
  read(path: string, as: 'arrayBuffer', opts?: CallOptions): Promise<ArrayBuffer>;
  stat?(path: string, opts?: CallOptions): Promise<Entry | null>;
  url?(entry: Entry): string | { url: string; withCredentials?: boolean };
  search?(query: string, opts?: CallOptions): Promise<Entry[]>;
  create?(path: string, kind: EntryKind): Promise<Entry>;
  write?(path: string, text: string, opts?: { expectedMtimeMs?: number }): Promise<Entry>;
  move?(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  copy?(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  delete?(path: string): Promise<void>;
  upload?: UploadTransport;
  download?(paths: string[]): Promise<Blob | { url: string; fileName?: string }>;
  /** Delivers batches of events, so a burst of changes costs one render. */
  watch?(onChange: (events: ChangeEvent[]) => void): () => void;
}
