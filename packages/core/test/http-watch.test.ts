import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { httpAdapter, type HttpAdapterOptions } from '../src/http';
import type { FsError } from '../src/errors';
import type { WatchOptions } from '../src/types';

const BASE = 'http://x.test/api';
const NOW = new Date('2026-01-01T00:00:00Z');

const status = (code: number, headers?: HeadersInit) => (): Response =>
  new Response('x', { status: code, ...(headers ? { headers } : {}) });
const hang = (): Response => new Response(new ReadableStream({ start: () => {} }));
const oneFrameThenEnd = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: []\n\n'));
        controller.close();
      },
    }),
  );

function watchWith(
  responses: Array<() => Response>,
  options: HttpAdapterOptions = {},
  watchOptions?: WatchOptions,
) {
  const attemptsAt: number[] = [];
  const listingsAt: number[] = [];
  const listedUrls: string[] = [];
  const errors: FsError[] = [];
  const fetch = (async (url: string) => {
    if (url.includes('/list')) {
      listingsAt.push(Date.now());
      listedUrls.push(url);
      return new Response(JSON.stringify({ entries: [] }));
    }
    attemptsAt.push(Date.now());
    return (responses.shift() ?? hang)();
  }) as typeof globalThis.fetch;
  const stop = httpAdapter(BASE, {
    fetch,
    reconnectDelaysMs: [10],
    onWatchError: (error) => errors.push(error),
    ...options,
  }).watch!(() => undefined, watchOptions);
  const gaps = (): number[] => attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]!);
  return { attemptsAt, listingsAt, listedUrls, errors, gaps, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('403 stops watching and reports once', async () => {
  const watching = watchWith([status(403), status(403)]);
  await vi.advanceTimersByTimeAsync(120_000);
  watching.stop();
  expect(watching.attemptsAt).toHaveLength(1);
  expect(watching.errors.map((error) => error.status)).toEqual([403]);
});

test('403 leads to listings polled at the polling interval, and says so once', async () => {
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 } });
  await vi.advanceTimersByTimeAsync(3500);
  watching.stop();
  const start = watching.attemptsAt[0]!;
  expect(watching.listingsAt.map((at) => at - start)).toEqual([1000, 2000, 3000]);
  expect(watching.errors).toHaveLength(1);
  expect(watching.errors[0]!.message).toContain('polling instead');
  expect(watching.errors[0]!.message).toContain('/docs/concepts/adapter#live-updates');
});

test('unwatching inside onWatchError never starts the polling', async () => {
  let unwatch = (): void => undefined;
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 }, onWatchError: () => unwatch() });
  unwatch = watching.stop;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(watching.listingsAt).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test('the fallback polls the folders pollPaths names', async () => {
  const watching = watchWith(
    [status(403)],
    { polling: { intervalMs: 1000, paths: () => ['ignored'] } },
    { pollPaths: () => ['', 'src'] },
  );
  await vi.advanceTimersByTimeAsync(1500);
  watching.stop();
  expect(watching.listedUrls.map((url) => new URL(url).searchParams.get('path')).sort()).toEqual(['', 'src']);
});

function stubDocument(hidden: boolean): { show: () => void; hide: () => void } {
  const fakeDocument = Object.assign(new EventTarget(), { hidden });
  vi.stubGlobal('document', fakeDocument);
  const becomeHidden = (nowHidden: boolean): void => {
    fakeDocument.hidden = nowHidden;
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
  };
  return { show: () => becomeHidden(false), hide: () => becomeHidden(true) };
}

test('the fallback polls nothing while the tab is hidden, and polls at once when it shows', async () => {
  const tab = stubDocument(true);
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 } });
  await vi.advanceTimersByTimeAsync(3500);
  expect(watching.listingsAt).toEqual([]);
  tab.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(watching.listingsAt.map((at) => at - watching.attemptsAt[0]!)).toEqual([3500]);
  watching.stop();
});

test('hiding and showing the tab again within the interval gives at most one immediate round', async () => {
  const tab = stubDocument(true);
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 } });
  await vi.advanceTimersByTimeAsync(3500);
  tab.show();
  await vi.advanceTimersByTimeAsync(200);
  tab.show();
  await vi.advanceTimersByTimeAsync(100);
  tab.hide();
  await vi.advanceTimersByTimeAsync(100);
  tab.show();
  await vi.advanceTimersByTimeAsync(1000);
  watching.stop();
  const start = watching.attemptsAt[0]!;
  expect(watching.listingsAt.map((at) => at - start)).toEqual([3500, 4500]);
});

test('after the watch stops, the tab showing again polls nothing', async () => {
  const tab = stubDocument(true);
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 } });
  await vi.advanceTimersByTimeAsync(1500);
  watching.stop();
  tab.show();
  await vi.advanceTimersByTimeAsync(5000);
  expect(watching.listingsAt).toEqual([]);
});

test('polling.isPaused and polling.resumeSignal replace the hidden-tab defaults', async () => {
  const tab = stubDocument(true);
  const watching = watchWith([status(403)], {
    polling: { intervalMs: 1000, isPaused: () => false, resumeSignal: () => () => undefined },
  });
  await vi.advanceTimersByTimeAsync(1500);
  tab.show();
  await vi.advanceTimersByTimeAsync(0);
  watching.stop();
  expect(watching.listingsAt.map((at) => at - watching.attemptsAt[0]!)).toEqual([1000]);
});

test('stopping the watch also stops the polling', async () => {
  const watching = watchWith([status(403)], { polling: { intervalMs: 1000 } });
  await vi.advanceTimersByTimeAsync(1500);
  watching.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(watching.listingsAt).toHaveLength(1);
});

test('401 retries at ≥ 5000 ms and reports once per streak', async () => {
  const watching = watchWith([status(401), status(401), oneFrameThenEnd, status(401), status(401)]);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(watching.attemptsAt).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  watching.stop();
  expect(watching.gaps()).toEqual([5_000, 5_000, 10, 5_000, 5_000]);
  expect(watching.errors.map((error) => error.status)).toEqual([401, 401]);
});

test('401 retries at the longest reconnect delay when that is longer than 5000 ms', async () => {
  const watching = watchWith([status(401)], { reconnectDelaysMs: [0, 8_000] });
  await vi.advanceTimersByTimeAsync(20_000);
  watching.stop();
  expect(watching.gaps()).toEqual([8_000]);
});

test.each([
  ['seconds', '7', 7_000],
  ['an HTTP date', 'Thu, 01 Jan 2026 00:00:20 GMT', 20_000],
  ['seconds over the cap', '3600', 60_000],
  ['a date over the cap', 'Fri, 02 Jan 2026 00:00:00 GMT', 60_000],
  ['zero seconds, floored at 1 s', '0', 1_000],
  ['a date in the past, floored at 1 s', 'Wed, 31 Dec 2025 00:00:00 GMT', 1_000],
])('503 Retry-After delays the retry (%s)', async (_form, retryAfter, expectedGapMs) => {
  const watching = watchWith([status(503, { 'Retry-After': retryAfter })]);
  await vi.advanceTimersByTimeAsync(120_000);
  watching.stop();
  expect(watching.gaps()).toEqual([expectedGapMs]);
  expect(watching.errors).toEqual([]);
});

test.each(['soon', '1.5', '-5', '2026-01-01T00:00:20Z', 'Thu, 01 Jan 2026 00:00:20'])(
  '503 with a malformed Retry-After %j uses the normal backoff',
  async (retryAfter) => {
    const watching = watchWith([status(503, { 'Retry-After': retryAfter })]);
    await vi.advanceTimersByTimeAsync(120_000);
    watching.stop();
    expect(watching.gaps()).toEqual([10]);
  },
);

test('503 Retry-After never retries sooner than the backoff step of that attempt', async () => {
  const watching = watchWith([status(503, { 'Retry-After': '2' }), status(503, { 'Retry-After': '2' })], {
    reconnectDelaysMs: [3_000, 4_000],
  });
  await vi.advanceTimersByTimeAsync(120_000);
  watching.stop();
  expect(watching.gaps()).toEqual([3_000, 4_000]);
});

function adapterWhoseWatchIsRefused(
  listResponse: (url: string) => Response,
  options: HttpAdapterOptions = {},
) {
  const listedPaths: string[] = [];
  const errors: FsError[] = [];
  const fetch = (async (url: string) => {
    if (!url.includes('/list')) return status(403)();
    listedPaths.push(new URL(url).searchParams.get('path') ?? '');
    return listResponse(url);
  }) as typeof globalThis.fetch;
  const adapter = httpAdapter(BASE, {
    fetch,
    onWatchError: (error) => errors.push(error),
    polling: { intervalMs: 1000 },
    ...options,
  });
  return { adapter, listedPaths, errors };
}

const emptyListing = (): Response => new Response(JSON.stringify({ entries: [] }));

test('a resync is delivered once, before the first poll, when the fallback starts', async () => {
  const { adapter } = adapterWhoseWatchIsRefused(emptyListing);
  const batches: string[][] = [];
  const stop = adapter.watch!((events) => batches.push(events.map((event) => event.type)));
  await vi.advanceTimersByTimeAsync(500);
  stop();
  expect(batches).toEqual([['resync']]);
});

test('polling gives up after 3 refused rounds and says so once', async () => {
  const { adapter, listedPaths, errors } = adapterWhoseWatchIsRefused(status(403));
  const stop = adapter.watch!(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  stop();
  expect(listedPaths).toHaveLength(3);
  const stopNotices = errors.filter((error) => error.message.includes('Polling stopped'));
  expect(stopNotices).toHaveLength(1);
  expect(stopNotices[0]!.message).toContain('/docs/concepts/adapter#live-updates');
  expect(vi.getTimerCount()).toBe(0);
});

test('polling never gives up on 401, since signing in again can fix it', async () => {
  const { adapter, listedPaths, errors } = adapterWhoseWatchIsRefused(status(401));
  const stop = adapter.watch!(() => undefined);
  await vi.advanceTimersByTimeAsync(300_000);
  stop();
  expect(listedPaths.length).toBeGreaterThan(3);
  expect(errors.filter((error) => error.message.includes('Polling stopped'))).toEqual([]);
});

test('a 401 round between 403 rounds neither counts nor resets the streak', async () => {
  const answers = [status(403), status(401)];
  const { adapter, listedPaths, errors } = adapterWhoseWatchIsRefused(() =>
    (answers.shift() ?? status(403))(),
  );
  const stop = adapter.watch!(() => undefined);
  await vi.advanceTimersByTimeAsync(300_000);
  stop();
  expect(listedPaths).toHaveLength(4);
  expect(errors.filter((error) => error.message.includes('Polling stopped'))).toHaveLength(1);
});

test('a round refused with both 403 and 401 counts towards giving up', async () => {
  const { adapter, listedPaths, errors } = adapterWhoseWatchIsRefused((url) =>
    status(url.includes('path=b') ? 401 : 403)(),
  );
  const stop = adapter.watch!(() => undefined, { pollPaths: () => ['a', 'b'] });
  await vi.advanceTimersByTimeAsync(300_000);
  stop();
  expect(listedPaths).toHaveLength(6);
  expect(errors.filter((error) => error.message.includes('Polling stopped'))).toHaveLength(1);
});

test('a resume signal after polling gave up does not start it again', async () => {
  let resume = (): void => undefined;
  const resumeSignal = (poll: () => void): (() => void) => {
    resume = poll;
    return () => undefined;
  };
  const { adapter, listedPaths, errors } = adapterWhoseWatchIsRefused(status(403), {
    polling: { intervalMs: 1000, resumeSignal },
  });
  const stop = adapter.watch!(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  resume();
  await vi.advanceTimersByTimeAsync(60_000);
  stop();
  expect(listedPaths).toHaveLength(3);
  expect(errors.filter((error) => error.message.includes('Polling stopped'))).toHaveLength(1);
});

test('a listing that succeeds resets the count of refused rounds', async () => {
  const answers = [status(403), status(403), emptyListing, status(403), status(403), emptyListing];
  const { adapter, listedPaths } = adapterWhoseWatchIsRefused(() => (answers.shift() ?? emptyListing)());
  const stop = adapter.watch!(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  stop();
  expect(listedPaths.length).toBeGreaterThan(6);
});

test('two watchers that fall back each poll their own paths', async () => {
  const { adapter, listedPaths } = adapterWhoseWatchIsRefused(emptyListing);
  const stopFirst = adapter.watch!(() => undefined, { pollPaths: () => ['one'] });
  const stopSecond = adapter.watch!(() => undefined, { pollPaths: () => ['two'] });
  await vi.advanceTimersByTimeAsync(1500);
  stopFirst();
  stopSecond();
  expect([...listedPaths].sort()).toEqual(['one', 'two']);
});
