import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { httpAdapter, type HttpAdapterOptions } from '../src/http';
import type { FsError } from '../src/errors';

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

function watchWith(responses: Array<() => Response>, options: HttpAdapterOptions = {}) {
  const attemptsAt: number[] = [];
  const errors: FsError[] = [];
  const fetch = (async () => {
    attemptsAt.push(Date.now());
    return (responses.shift() ?? hang)();
  }) as typeof globalThis.fetch;
  const stop = httpAdapter(BASE, {
    fetch,
    reconnectDelaysMs: [10],
    onWatchError: (error) => errors.push(error),
    ...options,
  }).watch!(() => undefined);
  const gaps = (): number[] => attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]!);
  return { attemptsAt, errors, gaps, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

test('403 stops watching and reports once', async () => {
  const watching = watchWith([status(403), status(403)]);
  await vi.advanceTimersByTimeAsync(120_000);
  watching.stop();
  expect(watching.attemptsAt).toHaveLength(1);
  expect(watching.errors.map((error) => error.status)).toEqual([403]);
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
