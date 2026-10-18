import {
  CSRF_HEADER, FsError, IF_MTIME_HEADER, MTIME_HEADER, ROUTES, basename, extname, normalizePath, parentPath, parseRoute, statusForKind,
} from '@scope/core';
import type {
  ChangeEvent, CreateBody, DownloadBody, EntriesResponse, Entry, EntryResponse, ErrorBody, StatResponse, TransferBody,
  UploadCompleteBody, UploadInitBody, UploadInitResponse,
} from '@scope/core';
import type { FileStore } from './store';
import { createUploads } from './uploads';
import { toFrames } from './watch';
import { zipStream } from './zip';
import type { ZipEntry } from './zip';

export type Operation = keyof typeof ROUTES;

export interface FileHandlerOptions {
  store: FileStore;
  /**
   * Called once per affected path before the store is touched; `false` -> 403. `watch` is asked with `''`.
   * `watch` is asked once, not per event: its events reveal the paths changed anywhere under the root, so principals scoped to part of
   * the tree must be denied `'watch'` (like `'list'`).
   * Directory `move`/`copy` also ask once per descendant (any denial rejects the whole operation) and a
   * directory `download` asks once per file it would include (denied files are left out of the zip).
   *
   * `list`, `search` and `stat` results are NOT filtered per entry: they reveal the names and metadata
   * of everything under the start path. Principals scoped to part of the tree must be denied the
   * `'list'` and `'search'` operations, or the hidden parts must be protected with the store's `exclude`.
   */
  authorize(req: Request, op: Operation, path: string): boolean | Promise<boolean>;
  /** Reject every mutating operation with 403. */
  readOnly?: boolean;
  /** Largest direct upload or chunked upload total. Default 1 GiB. */
  maxUploadBytes?: number;
  /** Largest `write` body. Default 10 MiB. */
  maxWriteBytes?: number;
  /** Chunk size told to chunked-upload clients. Default 8 MiB. */
  chunkSize?: number;
  /** Idle time after which an upload session is discarded. Default 1 hour. */
  uploadTtlMs?: number;
  /**
   * Name of the principal making a request (default `'user'`), recorded for changes made through this
   * handler. A `watch` stream tags a change `'user'` only for 2 s after it was written by a request
   * whose `actor` equals the watching request's; every other change is `'external'`, so one principal's
   * name is never sent to another.
   */
  actor?(req: Request): string;
  /** Interval of the `: ping` comment sent to each `watch` client. Default 25 s. */
  watchHeartbeatMs?: number;
  /** Called for unexpected failures (the response is a generic 500). */
  onError?(e: unknown, req: Request): void;
}

const MiB = 1024 * 1024;
const MAX_JSON_BYTES = MiB;
/** How long a path written through the handler keeps its actor tag, and how much a stuck `watch` client may queue. */
const ACTOR_WINDOW_MS = 2000;
const WATCH_QUEUE_BYTES = 4 * MiB;
/** A watch batch with more events than this is replaced by one `resync` event. */
const MAX_WATCH_BATCH = 10_000;
const PING = new TextEncoder().encode(': ping\n\n');
const WATCH_UNAVAILABLE = 'live updates are unavailable on this server';
/** Limits of a zip without zip64 extensions. */
const MAX_ZIP_ENTRIES = 0xffff;
const MAX_ZIP_BYTES = 0xffffffff;

const WRITE_OPS: ReadonlySet<Operation> = new Set<Operation>([
  'create', 'write', 'move', 'copy', 'delete', 'uploadDirect', 'uploadInit', 'uploadChunk', 'uploadComplete', 'uploadAbort',
]);
const UPLOAD_OPS: ReadonlySet<Operation> = new Set<Operation>(['uploadInit', 'uploadChunk', 'uploadComplete', 'uploadAbort']);

// Route table, longest route path first so `upload/init` wins over `upload`.
const TABLE = (Object.entries(ROUTES) as [Operation, string][])
  .map(([op, r]) => ({ op, ...parseRoute(r) }))
  .sort((a, b) => b.path.length - a.path.length);

// --- content types -------------------------------------------------------------------------

const TEXT = 'text/plain; charset=utf-8';
const MIME = new Map<string, string>();
const mime = (type: string, exts: string): void => exts.split(' ').forEach((e) => MIME.set(e, type));
mime('image/png', 'png');
mime('image/jpeg', 'jpg jpeg');
mime('image/gif', 'gif');
mime('image/webp', 'webp');
mime('image/avif', 'avif');
mime('image/bmp', 'bmp');
mime('image/x-icon', 'ico');
mime('image/svg+xml', 'svg');
mime('image/tiff', 'tif tiff');
mime('video/mp4', 'mp4 m4v');
mime('video/webm', 'webm');
mime('video/quicktime', 'mov');
mime('audio/mpeg', 'mp3');
mime('audio/wav', 'wav');
mime('audio/ogg', 'ogg oga');
mime('audio/flac', 'flac');
mime('audio/aac', 'aac');
mime('audio/mp4', 'm4a');
mime('application/pdf', 'pdf');
// Never html: a served page would run in the app's origin. Everything not listed is octet-stream.
mime(TEXT, 'txt md markdown csv tsv json yaml yml toml xml log js mjs cjs ts tsx jsx py go rs java c cpp h css sh');
const contentType = (name: string): string => MIME.get(extname(name)) ?? 'application/octet-stream';

/** RFC 5987 `filename*` value; also escapes the characters `encodeURIComponent` leaves alone. */
const disposition = (name: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

function fileHeaders(name: string, type: string): Headers {
  return new Headers({
    'Content-Type': type,
    'Content-Disposition': disposition(name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}

// --- responses and errors ------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const noContent = (): Response => new Response(null, { status: 204 });
const fail = (status: number, kind: ErrorBody['error']['kind'], message: string, headers: Record<string, string> = {}): Response =>
  jsonResponse({ error: { kind, message } } satisfies ErrorBody, status, headers);

/** Kinds whose message is safe to show: the store words them with relative paths only. */
const SHOWN = new Set(['not_found', 'conflict', 'forbidden', 'too_large', 'invalid', 'timeout']);

// --- request helpers -----------------------------------------------------------------------

const invalid = (message: string, path?: string): FsError => new FsError('invalid', message, path === undefined ? {} : { path });

function declaredTooLarge(req: Request, max: number, path?: string): void {
  const len = req.headers.get('content-length');
  if (len !== null && /^\d+$/.test(len) && Number(len) > max) {
    throw new FsError('too_large', `exceeds ${max} bytes`, path === undefined ? {} : { path });
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  declaredTooLarge(req, MAX_JSON_BYTES);
  const reader = req.body?.getReader();
  if (!reader) throw invalid('missing request body');
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_JSON_BYTES) throw new FsError('too_large', `request body exceeds ${MAX_JSON_BYTES} bytes`);
      parts.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } catch {
    throw invalid('request body is not valid JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid('request body must be a JSON object');
  return v as Record<string, unknown>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw invalid(`${name} must be a string`);
  return v;
};
const optBool = (v: unknown, name: string): boolean => {
  if (v !== undefined && typeof v !== 'boolean') throw invalid(`${name} must be a boolean`);
  return v === true;
};
const intParam = (v: string | null, name: string): number => {
  if (v === null || !/^\d{1,15}$/.test(v)) throw invalid(`${name} must be a non-negative integer`);
  return Number(v);
};

/**
 * Wraps a store body so it is cancelled (closing the file behind it) when the request aborts
 * or the consumer cancels it.
 */
function guard(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const stop = (): void => void reader.cancel().catch(() => {});
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  const off = (): void => signal.removeEventListener('abort', stop);
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            off();
            c.close();
          } else c.enqueue(r.value);
        } catch (e) {
          off();
          c.error(e);
        }
      },
      cancel(reason) {
        off();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Parses a single `Range` header. `undefined` means "ignore it and serve everything". */
function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim()); // a multi-range ("a-b,c-d") does not match
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

// --- handler -------------------------------------------------------------------------------

interface Ctx {
  req: Request;
  url: URL;
}
type Route = (c: Ctx) => Promise<Response>;

export function createFileHandler(opts: FileHandlerOptions): (req: Request) => Promise<Response> {
  if (typeof opts?.authorize !== 'function') throw new TypeError('createFileHandler: `authorize` is required');
  const { store } = opts;
  const maxUpload = opts.maxUploadBytes ?? 1024 * MiB;
  const maxWrite = opts.maxWriteBytes ?? 10 * MiB;
  const chunkSize = opts.chunkSize ?? 8 * MiB;
  const uploads = createUploads({ ttlMs: opts.uploadTtlMs ?? 3_600_000, chunkSize });

  // Paths this handler mutated in the last 2 s, with the writer's actor name (exact paths only).
  // ponytail: expired entries are swept on the next mutation once there are over 1000.
  const recent = new Map<string, { writer: string; until: number }>();
  /**
   * Runs a store mutation and remembers who made it, so the watcher can tell it from outside changes.
   * Marked: `targets`, the parent directories the mutation will create, and `inside` (entries known to move or vanish with a target).
   */
  async function tagged<T>(req: Request, targets: string[], fn: () => Promise<T>, inside: string[] = []): Promise<T> {
    const writer = opts.actor?.(req) ?? 'user';
    const paths = [...targets, ...inside];
    for (const t of targets) {
      for (let a = parentPath(t); a !== ''; a = parentPath(a)) {
        let st: Entry | null;
        try {
          st = await store.stat(a);
        } catch {
          break;
        }
        if (st) break;
        paths.push(a);
      }
    }
    const mark = (): void => {
      const now = Date.now();
      if (recent.size > 1000) for (const [k, v] of recent) if (v.until <= now) recent.delete(k);
      for (const p of paths) recent.set(p, { writer, until: now + ACTOR_WINDOW_MS });
    };
    mark();
    try {
      return await fn();
    } finally {
      mark();
    }
  }
  /** `'user'` only for a recent change written by the same principal as the watcher `me`; never another principal's name. */
  function actorOf(p: string, me: string): string {
    const r = recent.get(p);
    return r && r.until > Date.now() && r.writer === me ? 'user' : 'external';
  }

  const permitted = async (req: Request, op: Operation, path: string): Promise<boolean> => !!(await opts.authorize(req, op, path));
  const allow = async (req: Request, op: Operation, path: string): Promise<void> => {
    if (!(await permitted(req, op, path))) throw new FsError('forbidden', 'access denied', { path });
  };
  const pathParam = (url: URL): string => normalizePath(url.searchParams.get('path') ?? '');
  const entryJson = (entry: Entry): Response => jsonResponse({ entry } satisfies EntryResponse);

  /** One `store.write` for `write` and direct uploads: streamed, size-capped, parents created. */
  async function writeBody(
    req: Request, p: string, max: number, extra: { expectedMtimeMs?: number; overwrite?: boolean },
  ): Promise<Response> {
    declaredTooLarge(req, max, p);
    return entryJson(await tagged(req, [p], () => store.write(p, req.body ?? new Uint8Array(0), { ...extra, maxBytes: max })));
  }

  /** Stream of a single file with the download/read headers. */
  function fileResponse(
    c: Ctx, name: string, r: { body: ReadableStream<Uint8Array>; size: number; entry: Entry }, extra: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    const headers = fileHeaders(name, contentType(name));
    headers.set('Content-Length', String(r.size));
    if (r.entry.mtimeMs !== undefined) headers.set(MTIME_HEADER, String(r.entry.mtimeMs));
    for (const [k, v] of Object.entries(extra.headers ?? {})) headers.set(k, v);
    return new Response(guard(r.body, c.req.signal), { status: extra.status ?? 200, headers });
  }

  const routes: Partial<Record<Operation, Route>> = {
    async list({ req, url }) {
      const p = pathParam(url);
      await allow(req, 'list', p);
      const d = url.searchParams.get('depth');
      const depth = d === null ? 1 : Number(d);
      if (d === '' || !Number.isInteger(depth) || depth < 0) throw invalid('depth must be a non-negative integer', p);
      return jsonResponse({ entries: await store.list(p, depth) } satisfies EntriesResponse);
    },

    async stat({ req, url }) {
      const p = pathParam(url);
      await allow(req, 'stat', p);
      return jsonResponse({ entry: await store.stat(p) } satisfies StatResponse);
    },

    async read(c) {
      const p = pathParam(c.url);
      await allow(c.req, 'read', p);
      let range: { start: number; end: number } | undefined;
      const header = c.req.headers.get('Range');
      if (header) {
        const st = await store.stat(p);
        if (st?.kind === 'file') {
          const parsed = parseRange(header, st.size ?? 0);
          if (parsed === 'unsatisfiable') {
            return fail(416, 'invalid', 'range not satisfiable', { 'Content-Range': `bytes */${st.size ?? 0}` });
          }
          range = parsed;
        }
      }
      const r = await store.read(p, range);
      if (!range) return fileResponse(c, basename(p), r, { headers: { 'Accept-Ranges': 'bytes' } });
      return fileResponse(c, basename(p), r, {
        status: 206,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range.start}-${range.start + r.size - 1}/${r.entry.size ?? 0}` },
      });
    },

    async search({ req, url }) {
      await allow(req, 'search', '');
      if (!store.search) throw new FsError('not_found', 'search is not supported');
      return jsonResponse({ entries: await store.search(url.searchParams.get('q') ?? '', 200) } satisfies EntriesResponse);
    },

    async create({ req }) {
      const b = (await readJson(req)) as Partial<CreateBody>;
      const p = normalizePath(str(b.path, 'path'));
      const { kind } = b;
      if (kind !== 'file' && kind !== 'directory') throw invalid('kind must be "file" or "directory"', p);
      await allow(req, 'create', p);
      return entryJson(await tagged(req, [p], () => store.create(p, kind)));
    },

    async write({ req, url }) {
      const p = pathParam(url);
      await allow(req, 'write', p);
      const h = req.headers.get(IF_MTIME_HEADER);
      if (h !== null && !/^\d{1,16}$/.test(h)) throw invalid(`${IF_MTIME_HEADER} must be an integer`, p);
      // Plain write replaces an existing file (overwrite is deliberately left unset).
      return writeBody(req, p, maxWrite, h === null ? {} : { expectedMtimeMs: Number(h) });
    },

    move: (c) => transfer(c, 'move'),
    copy: (c) => transfer(c, 'copy'),

    async delete({ req, url }) {
      const p = pathParam(url);
      await allow(req, 'delete', p);
      const inside = await allowInside(req, p);
      await tagged(req, [p], () => store.delete(p), inside);
      return noContent();
    },

    async uploadDirect({ req, url }) {
      const p = pathParam(url);
      await allow(req, 'uploadDirect', p);
      return writeBody(req, p, maxUpload, { overwrite: url.searchParams.get('overwrite') === '1' });
    },

    async uploadInit({ req }) {
      const b = (await readJson(req)) as Partial<UploadInitBody>;
      const p = normalizePath(str(b.path, 'path'));
      const overwrite = optBool(b.overwrite, 'overwrite');
      const total = b.totalBytes;
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw invalid('totalBytes must be a non-negative integer', p);
      if (p === '') throw invalid('cannot upload to the root', p);
      await allow(req, 'uploadInit', p);
      if (total > maxUpload) throw new FsError('too_large', `upload exceeds ${maxUpload} bytes`, { path: p });
      const existing = await store.stat(p);
      if (existing && (existing.kind === 'directory' || !overwrite)) throw new FsError('conflict', `already exists: ${p}`, { path: p });
      const s = await uploads.init(p, total, overwrite);
      return jsonResponse({ uploadId: s.id, chunkSize } satisfies UploadInitResponse);
    },

    async uploadChunk({ req, url }) {
      const s = uploads.get(url.searchParams.get('id') ?? '');
      await allow(req, 'uploadChunk', s.path);
      const index = intParam(url.searchParams.get('index'), 'index');
      const offset = intParam(url.searchParams.get('offset'), 'offset');
      declaredTooLarge(req, s.chunkSize, s.path);
      await uploads.put(s, index, offset, req.body);
      return noContent();
    },

    async uploadComplete({ req }) {
      const b = (await readJson(req)) as Partial<UploadCompleteBody>;
      const s = uploads.get(str(b.uploadId, 'uploadId'));
      await allow(req, 'uploadComplete', s.path);
      if (s.completing) throw new FsError('conflict', 'upload is already completing', { path: s.path });
      const body = uploads.assemble(s); // 400 when a chunk is missing
      s.completing = true;
      try {
        // overwrite is explicit: an unset flag would replace a file that appeared after init
        const entry = await tagged(req, [s.path], () => store.write(s.path, body, { overwrite: s.overwrite, maxBytes: s.totalBytes }));
        await uploads.remove(s.id);
        return entryJson(entry);
      } catch (e) {
        await body.cancel().catch(() => {});
        throw e;
      } finally {
        s.completing = false;
      }
    },

    async uploadAbort({ req, url }) {
      const s = uploads.get(url.searchParams.get('id') ?? '');
      await allow(req, 'uploadAbort', s.path);
      if (s.completing) throw new FsError('conflict', 'upload is completing', { path: s.path });
      await uploads.remove(s.id);
      return noContent();
    },

    async watch({ req }) {
      await allow(req, 'watch', '');
      if (!store.watch) return fail(501, 'unknown', WATCH_UNAVAILABLE);
      if (req.signal.aborted) return new Response(null, { status: 204 });
      const me = opts.actor?.(req) ?? 'user';
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      let off: (() => void) | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const leave = (close: boolean): void => {
        if (done) return;
        done = true;
        off?.();
        clearInterval(beat);
        req.signal.removeEventListener('abort', onAbort);
        if (close) {
          try {
            ctl.close();
          } catch {
            // already cancelled
          }
        }
      };
      const onAbort = (): void => leave(true);
      // A client that stopped reading is cut off (it reconnects and reloads) rather than buffered without bound.
      const stuck = (): boolean => done || ((ctl.desiredSize ?? 0) <= 0 && (leave(true), true));
      const stream = new ReadableStream<Uint8Array>(
        { start: (c) => void (ctl = c), cancel: () => leave(false) },
        new ByteLengthQueuingStrategy({ highWaterMark: WATCH_QUEUE_BYTES }),
      );
      try {
        off = store.watch(
          (events) => {
            // Too many to be useful one by one: tell the client to reload instead.
            const out: ChangeEvent[] =
              events.length > MAX_WATCH_BATCH
                ? [{ type: 'resync', path: '' }]
                : events.map((e): ChangeEvent => ({ ...e, actor: actorOf(e.path, me) }));
            const enc = new TextEncoder();
            for (const frame of toFrames(out)) {
              if (stuck()) return; // the budget is checked before every frame, not once per batch
              ctl.enqueue(enc.encode(frame));
            }
          },
          () => leave(true),
        );
      } catch (e) {
        report(e, req);
        return fail(503, 'unknown', WATCH_UNAVAILABLE, { 'Retry-After': '10' }); // may be transient (e.g. out of watchers)
      }
      req.signal.addEventListener('abort', onAbort, { once: true });
      ctl.enqueue(PING); // the first bytes flush the response headers
      beat = setInterval(() => {
        if (!stuck()) ctl.enqueue(PING);
      }, opts.watchHeartbeatMs ?? 25_000);
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
      });
    },

    async download(c) {
      const b = (await readJson(c.req)) as Partial<DownloadBody>;
      if (!Array.isArray(b.paths) || b.paths.length === 0) throw invalid('paths must be a non-empty array');
      const paths = [...new Set(b.paths.map((p) => normalizePath(str(p, 'paths[]'))))];
      for (const p of paths) await allow(c.req, 'download', p);
      const stats: Entry[] = [];
      for (const p of paths) {
        const st = await store.stat(p);
        if (!st) throw new FsError('not_found', `ENOENT: ${p}`, { path: p });
        stats.push(st);
      }
      const only = stats[0]!;
      if (stats.length === 1 && only.kind === 'file') return fileResponse(c, basename(only.path), await store.read(only.path));

      // Plan the whole archive up front: fflate writes no zip64, so oversized archives must be refused before the first byte.
      const plan: ZipEntry[] = [];
      const seen = new Set<string>();
      let bytes = 0;
      for (const root of stats) {
        const parent = parentPath(root.path);
        const cut = parent === '' ? 0 : parent.length + 1;
        // ponytail: lists the whole subtree at once; stream per directory if huge trees matter.
        const items = root.kind === 'directory' ? [root, ...(await store.list(root.path, Infinity))] : [root];
        const denied: string[] = []; // denied folders; the list is breadth-first, so a folder precedes its contents
        for (const e of items) {
          if (e.path === '') continue;
          if (denied.some((d) => e.path.startsWith(`${d}/`))) continue;
          // The requested path was authorized above; every other entry must be allowed too, or it (and its subtree) is left out.
          if (e !== root && !(await permitted(c.req, 'download', e.path))) {
            if (e.kind === 'directory') denied.push(e.path);
            continue;
          }
          const name = e.path.slice(cut) + (e.kind === 'directory' ? '/' : '');
          if (seen.has(name)) continue;
          seen.add(name);
          // file bytes plus what the zip writes around them: local header, data descriptor, central entry, name twice
          bytes += (e.size ?? 0) + 30 + 16 + 46 + 2 * Buffer.byteLength(name);
          if (e.kind === 'directory') plan.push({ name, mtimeMs: e.mtimeMs });
          else {
            plan.push({
              name,
              mtimeMs: e.mtimeMs,
              open: async () => {
                try {
                  return guard((await store.read(e.path)).body, c.req.signal);
                } catch (err) {
                  if (err instanceof FsError && err.kind === 'not_found') return null;
                  throw err;
                }
              },
            });
          }
        }
      }
      if (plan.length > MAX_ZIP_ENTRIES || bytes >= MAX_ZIP_BYTES) {
        throw new FsError('too_large', 'download is too large for a zip archive; download fewer files at a time');
      }
      const zipName = stats.length === 1 ? `${basename(only.path) || 'download'}.zip` : 'download.zip';
      const headers = fileHeaders(zipName, 'application/zip');
      return new Response(zipStream(plan, c.req.signal, (e) => report(e, c.req)), { headers });
    },
  };

  async function transfer({ req }: Ctx, op: 'move' | 'copy'): Promise<Response> {
    const b = (await readJson(req)) as Partial<TransferBody>;
    const from = normalizePath(str(b.from, 'from'));
    const to = normalizePath(str(b.to, 'to'));
    const o = { overwrite: optBool(b.overwrite, 'overwrite') };
    await allow(req, op, from);
    await allow(req, op, to);
    // A directory carries every descendant along, so each one must be allowed; any denial changes nothing.
    const inside: string[] = [];
    if ((await store.stat(from))?.kind === 'directory') {
      for (const e of await store.list(from, Infinity)) {
        await allow(req, op, e.path);
        inside.push(e.path, to + e.path.slice(from.length));
      }
    }
    // Overwriting removes the destination (and everything in it), so that needs delete rights too.
    if (from !== to && o.overwrite && (await store.stat(to))) {
      await allow(req, 'delete', to);
      inside.push(...(await allowInside(req, to)));
    }
    return entryJson(await tagged(req, [from, to], () => store[op](from, to, o), inside));
  }

  /** Authorizes `delete` on everything inside directory `p` (nothing to do for a file or a missing path); returns those paths. */
  async function allowInside(req: Request, p: string): Promise<string[]> {
    if ((await store.stat(p))?.kind !== 'directory') return [];
    const paths: string[] = [];
    for (const e of await store.list(p, Infinity)) {
      await allow(req, 'delete', e.path);
      paths.push(e.path);
    }
    return paths;
  }

  function report(e: unknown, req: Request): void {
    try {
      opts.onError?.(e, req);
    } catch {
      // a broken logger must not break the response
    }
  }

  function errorResponse(e: unknown, req: Request): Response {
    if (e instanceof FsError && SHOWN.has(e.kind)) {
      return jsonResponse(
        { error: { kind: e.kind, message: e.message, ...(e.path === undefined ? {} : { path: e.path }) } } satisfies ErrorBody,
        statusForKind(e.kind),
      );
    }
    report(e, req);
    return fail(500, 'unknown', 'internal error');
  }

  return async (req) => {
    try {
      const url = new URL(req.url);
      const p = url.pathname.replace(/\/+$/, '');
      const suffix = TABLE.find((r) => p === `/${r.path}` || p.endsWith(`/${r.path}`))?.path;
      const candidates = TABLE.filter((r) => r.path === suffix);
      if (candidates.length === 0) return fail(404, 'not_found', 'unknown route');
      const hit = candidates.find((r) => r.method === req.method);
      if (!hit) return fail(405, 'invalid', 'method not allowed', { Allow: candidates.map((r) => r.method).join(', ') });
      const route = routes[hit.op];
      if (!route) return fail(404, 'not_found', 'unknown route');
      if (hit.method !== 'GET' && req.headers.get(CSRF_HEADER) !== '1') {
        throw new FsError('forbidden', `missing ${CSRF_HEADER} header`);
      }
      if (opts.readOnly && WRITE_OPS.has(hit.op)) throw new FsError('forbidden', 'the file service is read-only');
      if (UPLOAD_OPS.has(hit.op)) await uploads.sweep().catch(() => {});
      return await route({ req, url });
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}
