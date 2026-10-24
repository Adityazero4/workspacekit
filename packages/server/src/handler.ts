import {
  CSRF_HEADER,
  FsError,
  IF_MTIME_HEADER,
  MTIME_HEADER,
  ROUTES,
  basename,
  normalizePath,
  parentPath,
  parseRoute,
  statusForKind,
} from '@workspacekit/core';
import { docsLink } from '@workspacekit/core/docs';
import type {
  ChangeEvent,
  CreateBody,
  DownloadBody,
  EntriesResponse,
  Entry,
  EntryResponse,
  ErrorBody,
  StatResponse,
  TransferBody,
  UploadCompleteBody,
  UploadInitBody,
  UploadInitResponse,
} from '@workspacekit/core';
import { contentTypeFor, fileHeaders, parseRange, type ByteRange } from './http-headers';
import {
  invalidRequest,
  nonNegativeIntegerParam,
  optionalBoolean,
  readJsonObject,
  rejectDeclaredTooLarge,
  requireString,
} from './request-input';
import type { FileStore } from './store';
import { createUploads } from './uploads';
import { toFrames } from './watch';
import { zipStream, type ZipEntry } from './zip';

/**
 * The operation a request performs, as `authorize` sees it: a key of `ROUTES`.
 *
 * @example
 * const authorize = async (req: Request, op: Operation): Promise<boolean> =>
 *   isSignedIn(req) && (op === 'list' || op === 'read' || isAdmin(req));
 */
export type Operation = keyof typeof ROUTES;

/**
 * Options for `createFileHandler`: the store, the per-path authorization callback, limits and hooks.
 *
 * @example
 * const options: FileHandlerOptions = {
 *   store: nodeFsStore(root),
 *   authorize: async (req) => isSignedIn(req),
 *   readOnly: true,
 * };
 */
export interface FileHandlerOptions {
  store: FileStore;
  /**
   * Called at least once per affected path before the store is touched; it may be asked again for the same
   * path (link targets, zip entries when opened), so keep it free of side effects. Only `true` allows;
   * anything else is a 403.
   * A path that goes through a symlink inside the root is asked twice, as itself and as the link's target's
   * real path, and both must allow. `watch` is asked with `''`.
   * `watch` is asked once, not per event: its events reveal the paths changed anywhere under the root, so
   * principals scoped to part of the tree must be denied `'watch'` (like `'list'`). Directory `move`/`copy`
   * also ask once per descendant (any denial rejects the whole operation) and a directory `download` asks
   * once per file it would include (denied files are left out of the zip).
   *
   * `list` and `search` results are NOT filtered per entry: they reveal the names and metadata of
   * everything under the start path (`stat` is asked per path, so `authorize` can refuse it for a hidden
   * path). Principals scoped to part of the tree must be denied `'list'`, `'search'` and `'watch'`, or the
   * hidden parts must be protected with the store's `exclude`.
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
  /** Idle time after which an upload session is discarded, checked every quarter of it. Default 1 hour. */
  uploadTtlMs?: number;
  /** Most chunked uploads that may be unfinished at once; past it `upload/init` is a 503. Default 100. */
  maxUploadSessions?: number;
  /**
   * With an `actor` hook, most unfinished chunked uploads one actor may hold. Before refusing a new one, the
   * actor's oldest idle upload is discarded to make room. Default a quarter of `maxUploadSessions`.
   * Without an `actor` hook every request is one actor, so only the overall caps apply and one client can
   * use them all.
   */
  maxUploadSessionsPerActor?: number;
  /**
   * Most bytes that unfinished chunked uploads may keep in the upload temp folder: `upload/init` is a 503
   * when the declared totals would pass it, and a chunk is refused (413) while it streams when the bytes
   * actually written would. Default 4 GiB.
   */
  maxUploadTempBytes?: number;
  /**
   * With an `actor` hook, most bytes one actor's unfinished chunked uploads may declare; past it
   * `upload/init` is a 503, after the actor's oldest idle uploads are evicted if that makes room. Default a
   * quarter of `maxUploadTempBytes`. Without an `actor` hook only the overall cap applies.
   */
  maxUploadTempBytesPerActor?: number;
  /**
   * A folder you own (mode 0700) for chunked uploads, so a restarted server clears the sessions its previous
   * run left once they are older than `uploadTtlMs`. Sessions live only in a `workspacekit-uploads`
   * subfolder the handler creates and marks; an existing one with content but no marker is refused, and
   * nothing else in the folder is touched. Give each handler its own folder: a second live handler on the
   * same folder in one process is refused. By default each handler makes a fresh private folder under the
   * system temp directory, removed when the process exits, and nothing survives a restart. POSIX only
   * (Linux and macOS): on Windows every upload with `uploadTempDir` set answers 500, so leave it unset there.
   */
  uploadTempDir?: string;
  /**
   * Name of the principal making a request (default `'user'`), recorded for changes made through this
   * handler. A `watch` stream tags a change `'user'` only for 2 s after it was written by a request
   * whose `actor` equals the watching request's; every other change is `'external'`, so one principal's
   * name is never sent to another.
   */
  actor?(req: Request): string;
  /** Interval of the `: ping` comment sent to each `watch` client. Default 25 s. */
  watchHeartbeatMs?: number;
  /** Most `watch` streams open at once; past it `watch` is a 503 with `Retry-After`. Default 100. */
  maxWatchConnections?: number;
  /**
   * With an `actor` hook, most `watch` streams one actor may hold open; past it `watch` is a 503. Default a
   * quarter of `maxWatchConnections`. Without an `actor` hook only the overall cap applies.
   */
  maxWatchConnectionsPerActor?: number;
  /**
   * Longest a `watch` stream stays open; then the server closes it and the client reconnects. Default 1 hour.
   */
  watchMaxLifetimeMs?: number;
  /**
   * Most bytes a `watch` stream may hold unread. A client that falls further behind is disconnected; it
   * reconnects and reloads. Default 1 MiB.
   */
  watchBufferBytes?: number;
  /** Deepest `list` a client may ask for; a deeper `depth` is a 400. Default 16. */
  maxListDepth?: number;
  /** Most entries one `list` answers; a larger listing is a 413 and its walk stops there. Default 100,000. */
  maxListEntries?: number;
  /** Entries a `search` looks at before it answers with what it found so far. Default 100,000. */
  maxSearchVisits?: number;
  /** Time a `search` may walk before it answers with what it found so far. Default 5 s. */
  searchTimeoutMs?: number;
  /** Called for unexpected failures (the response is a generic 500). */
  onError?(e: unknown, req: Request): void;
}

const MiB = 1024 * 1024;
const ACTOR_TAG_WINDOW_MS = 2000;
const RECENT_WRITES_SWEEP_THRESHOLD = 1000;
const MAX_EVENTS_BEFORE_RESYNC = 10_000;
const PING = new TextEncoder().encode(': ping\n\n');
const WATCH_UNAVAILABLE = 'live updates are unavailable on this server';
const WATCH_RETRY_AFTER_SECONDS = '10';
const MAX_ZIP_ENTRIES_WITHOUT_ZIP64 = 0xffff;
const MAX_ZIP_BYTES_WITHOUT_ZIP64 = 0xffffffff;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_DATA_DESCRIPTOR_BYTES = 16;
const ZIP_CENTRAL_ENTRY_BYTES = 46;
const MAX_SEARCH_RESULTS = 200;
const UPLOADS_BUSY = 'too many unfinished uploads on this server; try again later';
const UPLOADS_RETRY_AFTER_SECONDS = '30';

const LONGEST_TIMER_MS = 2 ** 31 - 1;
const CUT_OFF = new FsError('too_large', 'the live-update client fell too far behind; reconnect to resume');
const WATCHERS_BUSY = 'too many live-update connections on this server; try again later';

const LIMIT_DEFAULTS = {
  maxUploadSessions: 100,
  maxUploadSessionsPerActor: 25,
  maxUploadTempBytes: 4 * 1024 * MiB,
  maxUploadTempBytesPerActor: 1024 * MiB,
  maxWatchConnections: 100,
  maxWatchConnectionsPerActor: 25,
  watchBufferBytes: MiB,
  watchMaxLifetimeMs: 3_600_000,
  maxListDepth: 16,
  maxListEntries: 100_000,
  maxSearchVisits: 100_000,
  searchTimeoutMs: 5_000,
};

type LimitName = keyof typeof LIMIT_DEFAULTS;

const WRITE_OPS: ReadonlySet<Operation> = new Set<Operation>([
  'create',
  'write',
  'move',
  'copy',
  'delete',
  'uploadDirect',
  'uploadInit',
  'uploadChunk',
  'uploadComplete',
  'uploadAbort',
]);
const KINDS_WITH_RELATIVE_PATH_MESSAGES = new Set([
  'cancelled',
  'not_found',
  'conflict',
  'forbidden',
  'too_large',
  'invalid',
  'timeout',
]);

const ROUTES_LONGEST_PATH_FIRST = (Object.entries(ROUTES) as [Operation, string][])
  .map(([op, route]) => ({ op, ...parseRoute(route) }))
  .sort((a, b) => b.path.length - a.path.length);

const ignoreError = (): void => undefined;

const quarterOf = (limit: number): number => Math.max(1, Math.floor(limit / 4));

function limitsOf(options: FileHandlerOptions): Record<LimitName, number> {
  const limits = { ...LIMIT_DEFAULTS };
  for (const name of Object.keys(LIMIT_DEFAULTS) as LimitName[]) {
    const value: unknown = options[name];
    if (value === undefined) continue;
    if (value !== Infinity && !(Number.isSafeInteger(value) && (value as number) >= 0)) {
      throw new TypeError(
        `createFileHandler: "${name}" must be a non-negative integer or Infinity. ` +
          `See ${docsLink('server/handler', 'limits')}`,
      );
    }
    limits[name] = value as number;
  }
  limits.maxUploadSessionsPerActor = options.maxUploadSessionsPerActor ?? quarterOf(limits.maxUploadSessions);
  limits.maxUploadTempBytesPerActor =
    options.maxUploadTempBytesPerActor ?? quarterOf(limits.maxUploadTempBytes);
  limits.maxWatchConnectionsPerActor =
    options.maxWatchConnectionsPerActor ?? quarterOf(limits.maxWatchConnections);
  return limits;
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const noContent = (): Response => new Response(null, { status: 204 });
const failure = (
  status: number,
  kind: ErrorBody['error']['kind'],
  message: string,
  headers: Record<string, string> = {},
): Response => jsonResponse({ error: { kind, message } } satisfies ErrorBody, status, headers);
const entryResponse = (entry: Entry): Response => jsonResponse({ entry } satisfies EntryResponse);
const pathParam = (url: URL): string => normalizePath(url.searchParams.get('path') ?? '');

function matchRoute(pathname: string, method: string): { op: Operation; method: string } | Response {
  const path = pathname.replace(/\/+$/, '');
  const suffix = ROUTES_LONGEST_PATH_FIRST.find(
    (route) => path === `/${route.path}` || path.endsWith(`/${route.path}`),
  )?.path;
  const candidates = ROUTES_LONGEST_PATH_FIRST.filter((route) => route.path === suffix);
  if (candidates.length === 0) return failure(404, 'not_found', 'unknown route');
  const match = candidates.find((route) => route.method === method);
  if (!match) {
    return failure(405, 'invalid', 'method not allowed', {
      Allow: candidates.map((route) => route.method).join(', '),
    });
  }
  return match;
}

function withoutCachingOrSniffing(response: Response): Response {
  if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

function cancelWithRequest(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onReadError: (error: unknown) => void = ignoreError,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const cancel = (): void => void reader.cancel().catch(ignoreError);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const stopListening = (): void => signal.removeEventListener('abort', cancel);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            stopListening();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          stopListening();
          if (!signal.aborted) onReadError(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        stopListening();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function zipBytesFor(entry: Entry, name: string): number {
  const wrapping = ZIP_LOCAL_HEADER_BYTES + ZIP_DATA_DESCRIPTOR_BYTES + ZIP_CENTRAL_ENTRY_BYTES;
  return (entry.size ?? 0) + wrapping + 2 * Buffer.byteLength(name);
}

const zipTooLarge = (): FsError =>
  new FsError('too_large', 'download is too large for a zip archive; download fewer files at a time');

function requestedDownloadPaths(body: Partial<DownloadBody>): string[] {
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    throw invalidRequest('paths must be a non-empty array');
  }
  return [...new Set(body.paths.map((path) => normalizePath(requireString(path, 'paths[]'))))];
}

class RecentWrites {
  readonly #store: FileStore;
  readonly #byPath = new Map<string, { writer: string; until: number }>();

  constructor(store: FileStore) {
    this.#store = store;
  }

  async record<T>(
    writer: string,
    targets: string[],
    mutation: () => Promise<T>,
    inside: string[] = [],
  ): Promise<T> {
    const paths = [...targets, ...inside, ...(await this.#parentsToBeCreated(targets))];
    this.#tag(paths, writer);
    try {
      return await mutation();
    } finally {
      this.#tag(paths, writer);
    }
  }

  actorSeenBy(path: string, watcher: string): string {
    const recent = this.#byPath.get(path);
    return recent && recent.until > Date.now() && recent.writer === watcher ? 'user' : 'external';
  }

  async #parentsToBeCreated(targets: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const target of targets) {
      let ancestor = parentPath(target);
      while (ancestor !== '') {
        const exists = await this.#store.stat(ancestor).then(
          (entry) => entry !== null,
          () => true,
        );
        if (exists) break;
        missing.push(ancestor);
        ancestor = parentPath(ancestor);
      }
    }
    return missing;
  }

  #tag(paths: string[], writer: string): void {
    const now = Date.now();
    if (this.#byPath.size > RECENT_WRITES_SWEEP_THRESHOLD) {
      for (const [path, recent] of this.#byPath) if (recent.until <= now) this.#byPath.delete(path);
    }
    for (const path of paths) this.#byPath.set(path, { writer, until: now + ACTOR_TAG_WINDOW_MS });
  }
}

class WatchConnection {
  readonly body: ReadableStream<Uint8Array>;
  readonly #request: Request;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #unsubscribe: (() => void) | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lifetime: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  readonly #encoder = new TextEncoder();

  constructor(request: Request, bufferBytes: number) {
    this.#request = request;
    this.body = new ReadableStream<Uint8Array>(
      { start: (controller) => void (this.#controller = controller), cancel: () => this.#close('cancelled') },
      new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes }),
    );
  }

  start(unsubscribe: () => void, timing: { heartbeatMs: number; lifetimeMs: number }): void {
    if (this.#closed) {
      unsubscribe();
      return;
    }
    this.#unsubscribe = unsubscribe;
    this.#request.signal.addEventListener('abort', this.#onAbort, { once: true });
    this.#controller.enqueue(PING);
    this.#heartbeat = setInterval(() => {
      if (!this.#cutOffIfStuck()) this.#controller.enqueue(PING);
    }, timing.heartbeatMs);
    if (timing.lifetimeMs <= LONGEST_TIMER_MS) {
      this.#lifetime = setTimeout(this.closeFromSource, timing.lifetimeMs);
    }
  }

  send(frames: string[]): void {
    for (const frame of frames) {
      if (this.#cutOffIfStuck()) return;
      this.#controller.enqueue(this.#encoder.encode(frame));
    }
  }

  closeFromSource = (): void => this.#close('close');

  readonly #onAbort = (): void => this.#close('close');

  #cutOffIfStuck(): boolean {
    if (this.#closed) return true;
    const stoppedReading = (this.#controller.desiredSize ?? 0) <= 0;
    if (stoppedReading) this.#close('discard');
    return stoppedReading;
  }

  #close(stream: 'close' | 'discard' | 'cancelled'): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#unsubscribe?.();
    } finally {
      clearInterval(this.#heartbeat);
      clearTimeout(this.#lifetime);
      this.#request.signal.removeEventListener('abort', this.#onAbort);
    }
    if (stream === 'cancelled') return;
    try {
      if (stream === 'discard') this.#controller.error(CUT_OFF);
      else this.#controller.close();
    } catch {
      return;
    }
  }
}

interface RouteRequest {
  request: Request;
  url: URL;
}

type Route = (route: RouteRequest) => Promise<Response>;

interface StoreRead {
  body: ReadableStream<Uint8Array>;
  size: number;
  entry: Entry;
}

class FileHandler {
  readonly #options: FileHandlerOptions;
  readonly #store: FileStore;
  readonly #maxUploadBytes: number;
  readonly #maxWriteBytes: number;
  readonly #chunkSize: number;
  readonly #limits: Record<LimitName, number>;
  readonly #uploads: ReturnType<typeof createUploads>;
  readonly #recentWrites: RecentWrites;
  readonly #routes: Record<Operation, Route>;
  #openWatchConnections = 0;
  readonly #openWatchConnectionsByActor = new Map<string, number>();

  constructor(options: FileHandlerOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#maxUploadBytes = options.maxUploadBytes ?? 1024 * MiB;
    this.#maxWriteBytes = options.maxWriteBytes ?? 10 * MiB;
    this.#chunkSize = options.chunkSize ?? 8 * MiB;
    this.#limits = limitsOf(options);
    this.#uploads = createUploads({
      ttlMs: options.uploadTtlMs ?? 3_600_000,
      chunkSize: this.#chunkSize,
      maxSessions: this.#limits.maxUploadSessions,
      maxSessionsPerActor: this.#limits.maxUploadSessionsPerActor,
      maxTempBytes: this.#limits.maxUploadTempBytes,
      maxTempBytesPerActor: this.#limits.maxUploadTempBytesPerActor,
      tempDir: options.uploadTempDir,
    });
    this.#recentWrites = new RecentWrites(this.#store);
    this.#routes = {
      list: (route) => this.#list(route),
      stat: (route) => this.#stat(route),
      read: (route) => this.#read(route),
      search: (route) => this.#search(route),
      create: (route) => this.#create(route),
      write: (route) => this.#write(route),
      move: (route) => this.#transfer(route, 'move'),
      copy: (route) => this.#transfer(route, 'copy'),
      delete: (route) => this.#delete(route),
      uploadDirect: (route) => this.#uploadDirect(route),
      uploadInit: (route) => this.#uploadInit(route),
      uploadChunk: (route) => this.#uploadChunk(route),
      uploadComplete: (route) => this.#uploadComplete(route),
      uploadAbort: (route) => this.#uploadAbort(route),
      watch: (route) => this.#watch(route),
      download: (route) => this.#download(route),
    };
  }

  handle = async (request: Request): Promise<Response> =>
    withoutCachingOrSniffing(await this.#respond(request));

  async #respond(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const match = matchRoute(url.pathname, request.method);
      if (match instanceof Response) return match;
      if (match.method !== 'GET' && request.headers.get(CSRF_HEADER) !== '1') {
        throw new FsError('forbidden', `missing ${CSRF_HEADER} header`);
      }
      if (this.#options.readOnly && WRITE_OPS.has(match.op)) {
        throw new FsError('forbidden', 'the file service is read-only');
      }
      return await this.#routes[match.op]({ request, url });
    } catch (error) {
      return this.#errorResponse(error, request);
    }
  }

  #actorOf(request: Request): string {
    return this.#options.actor?.(request) ?? 'user';
  }

  #recordWrite<T>(
    request: Request,
    targets: string[],
    mutation: () => Promise<T>,
    inside?: string[],
  ): Promise<T> {
    return this.#recentWrites.record(this.#actorOf(request), targets, mutation, inside);
  }

  async #authorizedRealPath(request: Request, op: Operation, path: string): Promise<string | null> {
    if ((await this.#options.authorize(request, op, path)) !== true) return null;
    const canonical = await this.#canonicalPath(path);
    if (canonical === path || (await this.#options.authorize(request, op, canonical)) === true) {
      return canonical;
    }
    return null;
  }

  async #permitted(request: Request, op: Operation, path: string): Promise<boolean> {
    return (await this.#authorizedRealPath(request, op, path)) !== null;
  }

  async #canonicalPath(path: string): Promise<string> {
    if (!this.#store.canonicalPath) return path;
    try {
      return await this.#store.canonicalPath(path);
    } catch (error) {
      if (error instanceof FsError && error.kind === 'not_found') return path;
      throw error;
    }
  }

  async #allow(request: Request, op: Operation, path: string): Promise<string> {
    const realPath = await this.#authorizedRealPath(request, op, path);
    if (realPath === null) throw new FsError('forbidden', 'access denied', { path });
    return realPath;
  }

  async #writeRequestBody(
    request: Request,
    path: string,
    maxBytes: number,
    extra: { expectedMtimeMs?: number; overwrite?: boolean },
  ): Promise<Response> {
    rejectDeclaredTooLarge(request, maxBytes, path);
    const body = request.body ?? new Uint8Array(0);
    return entryResponse(
      await this.#recordWrite(request, [path], () => this.#store.write(path, body, { ...extra, maxBytes })),
    );
  }

  #fileResponse(
    request: Request,
    name: string,
    read: StoreRead,
    extra: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    const headers = fileHeaders(name, contentTypeFor(name));
    headers.set('Content-Length', String(read.size));
    if (read.entry.mtimeMs !== undefined) headers.set(MTIME_HEADER, String(read.entry.mtimeMs));
    for (const [key, value] of Object.entries(extra.headers ?? {})) headers.set(key, value);
    const body = cancelWithRequest(read.body, request.signal, (error) => this.#report(error, request));
    return new Response(body, {
      status: extra.status ?? 200,
      headers,
    });
  }

  async #list({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    await this.#allow(request, 'list', path);
    const depthParam = url.searchParams.get('depth');
    const depth = depthParam === null ? 1 : Number(depthParam);
    if (depthParam === '' || !Number.isInteger(depth) || depth < 0) {
      throw invalidRequest('depth must be a non-negative integer', path);
    }
    const { maxListDepth, maxListEntries } = this.#limits;
    if (depth > maxListDepth) throw invalidRequest(`depth must be at most ${maxListDepth}`, path);
    const entries = await this.#store.list(path, depth, {
      signal: request.signal,
      maxEntries: maxListEntries,
    });
    if (entries.length > maxListEntries) {
      throw new FsError('too_large', `more than ${maxListEntries} entries; list fewer levels at a time`, {
        path,
      });
    }
    return jsonResponse({ entries } satisfies EntriesResponse);
  }

  async #stat({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    await this.#allow(request, 'stat', path);
    return jsonResponse({ entry: await this.#store.stat(path) } satisfies StatResponse);
  }

  async #requestedRange(request: Request, path: string): Promise<ByteRange | Response | undefined> {
    const header = request.headers.get('Range');
    if (!header) return undefined;
    const entry = await this.#store.stat(path);
    if (entry?.kind !== 'file') return undefined;
    const size = entry.size ?? 0;
    const range = parseRange(header, size);
    if (range !== 'unsatisfiable') return range;
    return failure(416, 'invalid', 'range not satisfiable', { 'Content-Range': `bytes */${size}` });
  }

  async #read({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    const expectedCanonicalPath = await this.#allow(request, 'read', path);
    const range = await this.#requestedRange(request, path);
    if (range instanceof Response) return range;
    const read = await this.#store.read(path, range, { expectedCanonicalPath });
    if (!range) {
      return this.#fileResponse(request, basename(path), read, { headers: { 'Accept-Ranges': 'bytes' } });
    }
    const contentRange = `bytes ${range.start}-${range.start + read.size - 1}/${read.entry.size ?? 0}`;
    return this.#fileResponse(request, basename(path), read, {
      status: 206,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': contentRange },
    });
  }

  async #search({ request, url }: RouteRequest): Promise<Response> {
    await this.#allow(request, 'search', '');
    if (!this.#store.search) throw new FsError('not_found', 'search is not supported');
    const entries = await this.#store.search(url.searchParams.get('q') ?? '', MAX_SEARCH_RESULTS, {
      signal: request.signal,
      maxVisits: this.#limits.maxSearchVisits,
      timeoutMs: this.#limits.searchTimeoutMs,
    });
    return jsonResponse({ entries } satisfies EntriesResponse);
  }

  async #create({ request }: RouteRequest): Promise<Response> {
    const body = (await readJsonObject(request)) as Partial<CreateBody>;
    const path = normalizePath(requireString(body.path, 'path'));
    const { kind } = body;
    if (kind !== 'file' && kind !== 'directory') {
      throw invalidRequest('kind must be "file" or "directory"', path);
    }
    await this.#allow(request, 'create', path);
    return entryResponse(await this.#recordWrite(request, [path], () => this.#store.create(path, kind)));
  }

  async #write({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    await this.#allow(request, 'write', path);
    const ifMtime = request.headers.get(IF_MTIME_HEADER);
    if (ifMtime !== null && !/^\d{1,16}$/.test(ifMtime)) {
      throw invalidRequest(`${IF_MTIME_HEADER} must be an integer`, path);
    }
    const expectedMtime = ifMtime === null ? {} : { expectedMtimeMs: Number(ifMtime) };
    return this.#writeRequestBody(request, path, this.#maxWriteBytes, expectedMtime);
  }

  async #authorizeDescendantsCarriedAlong(
    request: Request,
    op: 'move' | 'copy',
    from: string,
    to: string,
  ): Promise<string[]> {
    if ((await this.#store.stat(from))?.kind !== 'directory') return [];
    const carried: string[] = [];
    for (const entry of await this.#store.list(from, Infinity, { signal: request.signal })) {
      await this.#allow(request, op, entry.path);
      carried.push(entry.path, to + entry.path.slice(from.length));
    }
    return carried;
  }

  async #authorizeDeleteInside(request: Request, path: string): Promise<string[]> {
    if ((await this.#store.stat(path))?.kind !== 'directory') return [];
    const inside: string[] = [];
    for (const entry of await this.#store.list(path, Infinity, { signal: request.signal })) {
      await this.#allow(request, 'delete', entry.path);
      inside.push(entry.path);
    }
    return inside;
  }

  async #transfer({ request }: RouteRequest, op: 'move' | 'copy'): Promise<Response> {
    const body = (await readJsonObject(request)) as Partial<TransferBody>;
    const from = normalizePath(requireString(body.from, 'from'));
    const to = normalizePath(requireString(body.to, 'to'));
    const options = { overwrite: optionalBoolean(body.overwrite, 'overwrite') };
    await this.#allow(request, op, from);
    await this.#allow(request, op, to);
    const affected = await this.#authorizeDescendantsCarriedAlong(request, op, from, to);
    const overwritesDestination = from !== to && options.overwrite && (await this.#store.stat(to)) !== null;
    if (overwritesDestination) {
      await this.#allow(request, 'delete', to);
      affected.push(...(await this.#authorizeDeleteInside(request, to)));
    }
    const entry = await this.#recordWrite(
      request,
      [from, to],
      () => this.#store[op](from, to, options),
      affected,
    );
    return entryResponse(entry);
  }

  async #delete({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    await this.#allow(request, 'delete', path);
    const inside = await this.#authorizeDeleteInside(request, path);
    await this.#recordWrite(request, [path], () => this.#store.delete(path), inside);
    return noContent();
  }

  async #uploadDirect({ request, url }: RouteRequest): Promise<Response> {
    const path = pathParam(url);
    await this.#allow(request, 'uploadDirect', path);
    const overwrite = url.searchParams.get('overwrite') === '1';
    return this.#writeRequestBody(request, path, this.#maxUploadBytes, { overwrite });
  }

  async #uploadInit({ request }: RouteRequest): Promise<Response> {
    const body = (await readJsonObject(request)) as Partial<UploadInitBody>;
    const path = normalizePath(requireString(body.path, 'path'));
    const overwrite = optionalBoolean(body.overwrite, 'overwrite');
    const total = body.totalBytes;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
      throw invalidRequest('totalBytes must be a non-negative integer', path);
    }
    if (path === '') throw invalidRequest('cannot upload to the root', path);
    await this.#allow(request, 'uploadInit', path);
    if (total > this.#maxUploadBytes) {
      throw new FsError('too_large', `upload exceeds ${this.#maxUploadBytes} bytes`, { path });
    }
    const existing = await this.#store.stat(path);
    if (existing && (existing.kind === 'directory' || !overwrite)) {
      throw new FsError('conflict', `already exists: ${path}`, { path });
    }
    const actor = this.#options.actor ? this.#actorOf(request) : undefined;
    const session = await this.#uploads.init(path, total, overwrite, actor);
    if (!session) {
      return failure(503, 'unknown', UPLOADS_BUSY, { 'Retry-After': UPLOADS_RETRY_AFTER_SECONDS });
    }
    return jsonResponse({ uploadId: session.id, chunkSize: this.#chunkSize } satisfies UploadInitResponse);
  }

  async #uploadChunk({ request, url }: RouteRequest): Promise<Response> {
    const session = this.#uploads.peek(url.searchParams.get('id') ?? '');
    await this.#allow(request, 'uploadChunk', session.path);
    this.#uploads.touch(session);
    const index = nonNegativeIntegerParam(url.searchParams.get('index'), 'index');
    const offset = nonNegativeIntegerParam(url.searchParams.get('offset'), 'offset');
    rejectDeclaredTooLarge(request, session.chunkSize, session.path);
    await this.#uploads.put(session, index, offset, request.body);
    return noContent();
  }

  async #uploadComplete({ request }: RouteRequest): Promise<Response> {
    const body = (await readJsonObject(request)) as Partial<UploadCompleteBody>;
    const session = this.#uploads.peek(requireString(body.uploadId, 'uploadId'));
    await this.#allow(request, 'uploadComplete', session.path);
    this.#uploads.touch(session);
    if (session.completing) {
      throw new FsError('conflict', 'upload is already completing', { path: session.path });
    }
    const assembled = this.#uploads.assemble(session);
    session.completing = true;
    try {
      const writeOptions = { overwrite: session.overwrite, maxBytes: session.totalBytes };
      const entry = await this.#recordWrite(request, [session.path], () =>
        this.#store.write(session.path, assembled, writeOptions),
      );
      await this.#uploads.remove(session.id);
      return entryResponse(entry);
    } catch (error) {
      await assembled.cancel().catch(ignoreError);
      throw error;
    } finally {
      session.completing = false;
    }
  }

  async #uploadAbort({ request, url }: RouteRequest): Promise<Response> {
    const session = this.#uploads.peek(url.searchParams.get('id') ?? '');
    await this.#allow(request, 'uploadAbort', session.path);
    if (session.completing) throw new FsError('conflict', 'upload is completing', { path: session.path });
    await this.#uploads.remove(session.id);
    return noContent();
  }

  #framesFor(events: ChangeEvent[], watcher: string): string[] {
    const tagged =
      events.length > MAX_EVENTS_BEFORE_RESYNC
        ? [{ type: 'resync', path: '' } satisfies ChangeEvent]
        : events.map((event): ChangeEvent => ({
            ...event,
            actor: this.#recentWrites.actorSeenBy(event.path, watcher),
          }));
    return toFrames(tagged);
  }

  #claimWatchSlot(actor: string | undefined): (() => void) | undefined {
    const byActor = this.#openWatchConnectionsByActor;
    const ofActor = actor === undefined ? 0 : (byActor.get(actor) ?? 0);
    if (this.#openWatchConnections >= this.#limits.maxWatchConnections) return undefined;
    if (actor !== undefined && ofActor >= this.#limits.maxWatchConnectionsPerActor) return undefined;
    this.#openWatchConnections++;
    if (actor !== undefined) byActor.set(actor, ofActor + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#openWatchConnections--;
      if (actor === undefined) return;
      const left = (byActor.get(actor) ?? 1) - 1;
      if (left > 0) byActor.set(actor, left);
      else byActor.delete(actor);
    };
  }

  async #watch({ request }: RouteRequest): Promise<Response> {
    await this.#allow(request, 'watch', '');
    const store = this.#store;
    if (!store.watch) return failure(501, 'unknown', WATCH_UNAVAILABLE);
    if (request.signal.aborted) return new Response(null, { status: 204 });
    const watcher = this.#actorOf(request);
    const release = this.#claimWatchSlot(this.#options.actor ? watcher : undefined);
    if (!release) return failure(503, 'unknown', WATCHERS_BUSY, { 'Retry-After': WATCH_RETRY_AFTER_SECONDS });
    const connection = new WatchConnection(request, this.#limits.watchBufferBytes);
    let unsubscribe: () => void;
    try {
      unsubscribe = store.watch(
        (events) => connection.send(this.#framesFor(events, watcher)),
        (error) => {
          this.#report(error, request);
          connection.closeFromSource();
        },
      );
    } catch (error) {
      release();
      this.#report(error, request);
      return failure(503, 'unknown', WATCH_UNAVAILABLE, { 'Retry-After': WATCH_RETRY_AFTER_SECONDS });
    }
    const stopWatching = (): void => {
      try {
        unsubscribe();
      } catch (error) {
        this.#report(error, request);
      } finally {
        release();
      }
    };
    const heartbeatMs = this.#options.watchHeartbeatMs ?? 25_000;
    connection.start(stopWatching, { heartbeatMs, lifetimeMs: this.#limits.watchMaxLifetimeMs });
    return new Response(connection.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  async #statAll(paths: string[]): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const path of paths) {
      const entry = await this.#store.stat(path);
      if (!entry) throw new FsError('not_found', `ENOENT: ${path}`, { path });
      entries.push(entry);
    }
    return entries;
  }

  #zipEntry(request: Request, entry: Entry, name: string): ZipEntry {
    if (entry.kind === 'directory') return { name, mtimeMs: entry.mtimeMs };
    return {
      name,
      mtimeMs: entry.mtimeMs,
      open: async () => {
        const expectedCanonicalPath = await this.#authorizedRealPath(request, 'download', entry.path);
        if (expectedCanonicalPath === null) return null;
        try {
          const read = await this.#store.read(entry.path, undefined, { expectedCanonicalPath });
          return cancelWithRequest(read.body, request.signal);
        } catch (error) {
          if (error instanceof FsError && (error.kind === 'not_found' || error.kind === 'conflict')) {
            return null;
          }
          throw error;
        }
      },
    };
  }

  #zipWalk(request: Request, root: Entry): Promise<Entry[]> {
    const options = { signal: request.signal, maxEntries: MAX_ZIP_ENTRIES_WITHOUT_ZIP64 };
    return this.#store.list(root.path, Infinity, options);
  }

  async #planZipArchive(request: Request, roots: Entry[]): Promise<ZipEntry[]> {
    const plan: ZipEntry[] = [];
    const names = new Set<string>();
    let bytes = 0;
    for (const root of roots) {
      const parent = parentPath(root.path);
      const nameStart = parent === '' ? 0 : parent.length + 1;
      const breadthFirst =
        root.kind === 'directory' ? [root, ...(await this.#zipWalk(request, root))] : [root];
      if (plan.length + breadthFirst.length > MAX_ZIP_ENTRIES_WITHOUT_ZIP64) throw zipTooLarge();
      const deniedFolders: string[] = [];
      for (const entry of breadthFirst) {
        if (entry.path === '' || deniedFolders.some((denied) => entry.path.startsWith(`${denied}/`))) {
          continue;
        }
        if (entry !== root && !(await this.#permitted(request, 'download', entry.path))) {
          if (entry.kind === 'directory') deniedFolders.push(entry.path);
          continue;
        }
        const name = entry.path.slice(nameStart) + (entry.kind === 'directory' ? '/' : '');
        if (names.has(name)) continue;
        names.add(name);
        bytes += zipBytesFor(entry, name);
        if (bytes >= MAX_ZIP_BYTES_WITHOUT_ZIP64) throw zipTooLarge();
        plan.push(this.#zipEntry(request, entry, name));
      }
    }
    return plan;
  }

  async #download({ request }: RouteRequest): Promise<Response> {
    const paths = requestedDownloadPaths(await readJsonObject(request));
    const realPaths: string[] = [];
    for (const path of paths) realPaths.push(await this.#allow(request, 'download', path));
    const entries = await this.#statAll(paths);
    const first = entries[0]!;
    if (entries.length === 1 && first.kind === 'file') {
      const read = await this.#store.read(first.path, undefined, { expectedCanonicalPath: realPaths[0] });
      return this.#fileResponse(request, basename(first.path), read);
    }
    const plan = await this.#planZipArchive(request, entries);
    const zipName = entries.length === 1 ? `${basename(first.path) || 'download'}.zip` : 'download.zip';
    const body = zipStream(plan, request.signal, (error) => this.#report(error, request));
    return new Response(body, { headers: fileHeaders(zipName, 'application/zip') });
  }

  #report(error: unknown, request: Request): void {
    try {
      this.#options.onError?.(error, request);
    } catch {
      return;
    }
  }

  #errorResponse(error: unknown, request: Request): Response {
    if (error instanceof FsError && KINDS_WITH_RELATIVE_PATH_MESSAGES.has(error.kind)) {
      const path = error.path === undefined ? {} : { path: error.path };
      return jsonResponse(
        { error: { kind: error.kind, message: error.message, ...path } } satisfies ErrorBody,
        statusForKind(error.kind),
      );
    }
    this.#report(error, request);
    return failure(500, 'unknown', 'internal error');
  }
}

/**
 * A fetch-style handler serving the `ROUTES` protocol from a `FileStore`. Every request is authorized per
 * path before the store is touched, every non-GET request needs the `X-FS-Request: 1` header, and errors
 * carry a message only for kinds the store words with relative paths (anything else is a generic 500 reported
 * to `onError`).
 *
 * Writes made through the handler are tagged with the writer's `actor` for 2 s, so a `watch` stream reports
 * them as `'user'` to the same principal and `'external'` to everyone else. A watch client that falls more
 * than `watchBufferBytes` behind is cut off (it reconnects and reloads), and a batch of over 10,000 events
 * becomes one `resync` event. A multi-file download is planned in full first: the zip writer has no
 * zip64 support, so an archive too large for it is refused before the first byte.
 *
 * Every size, count and walk is bounded by an overridable limit (see the options; each must be a
 * non-negative integer or `Infinity`), every walk stops when the request is aborted, and every response is
 * `Cache-Control: private, no-store` with `X-Content-Type-Options: nosniff`.
 *
 * @example
 * const handler = createFileHandler({
 *   store: nodeFsStore('/srv/workspace'),
 *   authorize: async (req) => isSignedIn(req),
 * });
 * const response = await handler(new Request('http://localhost/api/files/list?path='));
 */
export function createFileHandler(opts: FileHandlerOptions): (req: Request) => Promise<Response> {
  if (typeof opts?.authorize !== 'function') {
    throw new TypeError(
      'createFileHandler: "authorize" is required. Pass authorize: (req, op, path) => boolean, which must check the ' +
        `signed-in user. See ${docsLink('server/handler', 'authorize')}`,
    );
  }
  return new FileHandler(opts).handle;
}
