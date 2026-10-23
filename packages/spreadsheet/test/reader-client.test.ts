import { expect, test } from 'vitest';
import { createWorkerReader, isSuperseded } from '../src/reader/client';
import type { ReaderRequest, ReaderResponse } from '../src/reader/session';
import { ReaderError } from '../src/reader/types';

class FakeWorker extends EventTarget {
  readonly received: ReaderRequest[] = [];
  isTerminated = false;

  postMessage(request: ReaderRequest): void {
    this.received.push(request);
  }

  terminate(): void {
    this.isTerminated = true;
  }

  answer(id: number, result: unknown = { sheets: [] }): void {
    const response: ReaderResponse = { id, ok: true, result: result as never };
    this.dispatchEvent(new MessageEvent('message', { data: response }));
  }

  crash(): void {
    this.dispatchEvent(new Event('error'));
  }
}

function fakeWorkers(): { workers: FakeWorker[]; workerFactory: () => Worker } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  };
}

const settled = <Value>(promise: Promise<Value>): Promise<{ value?: Value; error?: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

test('the worker starts lazily, and responses are matched to requests by id', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  expect(workers).toHaveLength(0);
  const opening = reader.open(new ArrayBuffer(4), 'csv');
  const [open] = workers[0]!.received;
  expect(open).toMatchObject({ type: 'open', format: 'csv' });
  workers[0]!.answer(open!.id, { sheets: [{ name: 'Sheet1', isHidden: false }] });
  await expect(opening).resolves.toEqual({ sheets: [{ name: 'Sheet1', isHidden: false }] });
});

test('a newer request wins: the older one is superseded and its late answer is dropped', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  const first = settled(reader.sheet(0));
  const second = reader.sheet(1);
  const [older, newer] = workers[0]!.received;
  workers[0]!.answer(newer!.id, 'second sheet');
  workers[0]!.answer(older!.id, 'first sheet');
  await expect(second).resolves.toBe('second sheet');
  expect(isSuperseded((await first).error)).toBe(true);
});

test('a new open supersedes pending sheet and search requests', async () => {
  const { workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  const sheet = settled(reader.sheet(0));
  const search = settled(reader.search(0, 'x'));
  void settled(reader.open(new ArrayBuffer(1), 'xlsx'));
  expect(isSuperseded((await sheet).error)).toBe(true);
  expect(isSuperseded((await search).error)).toBe(true);
});

test('a crash rejects what is pending; the next request starts a new worker that reopens the workbook first', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  const data = new ArrayBuffer(8);
  void settled(reader.open(data, 'xlsx'));
  workers[0]!.answer(workers[0]!.received[0]!.id);
  const pending = settled(reader.sheet(0));
  workers[0]!.crash();
  const { error } = await pending;
  expect(error).toBeInstanceOf(ReaderError);
  expect((error as ReaderError).kind).toBe('load_error');
  expect(workers[0]!.isTerminated).toBe(true);
  const retried = reader.sheet(0);
  expect(workers).toHaveLength(2);
  const [reopen, sheet] = workers[1]!.received;
  expect(reopen).toMatchObject({ type: 'open', format: 'xlsx', data });
  workers[1]!.answer(reopen!.id);
  workers[1]!.answer(sheet!.id, 'sheet after recovery');
  await expect(retried).resolves.toBe('sheet after recovery');
});

test('errors from the worker arrive as ReaderErrors with their kind', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  const opening = settled(reader.open(new ArrayBuffer(1), 'xlsx'));
  const response: ReaderResponse = {
    id: workers[0]!.received[0]!.id,
    ok: false,
    error: { kind: 'too_large', message: 'Too big.' },
  };
  workers[0]!.dispatchEvent(new MessageEvent('message', { data: response }));
  expect((await opening).error).toMatchObject({ kind: 'too_large', message: 'Too big.' });
});

test('an open while the worker is busy terminates it, so the abandoned work stops, and a fresh worker opens', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  void settled(reader.open(new ArrayBuffer(1), 'xlsx'));
  workers[0]!.answer(workers[0]!.received[0]!.id);
  const slowSheet = settled(reader.sheet(0));
  const opening = reader.open(new ArrayBuffer(2), 'csv');
  expect(workers[0]!.isTerminated).toBe(true);
  expect(isSuperseded((await slowSheet).error)).toBe(true);
  expect(workers).toHaveLength(2);
  expect(workers[1]!.received.map((request) => request.type)).toEqual(['open']);
  workers[1]!.answer(workers[1]!.received[0]!.id, { sheets: [] });
  await expect(opening).resolves.toEqual({ sheets: [] });
});

test('after dispose every call rejects and no worker starts again', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  void settled(reader.open(new ArrayBuffer(1), 'xlsx'));
  reader.dispose();
  expect(isSuperseded((await settled(reader.sheet(0))).error)).toBe(true);
  expect(isSuperseded((await settled(reader.open(new ArrayBuffer(1), 'csv'))).error)).toBe(true);
  expect(workers).toHaveLength(1);
});

test('an error event from a worker that was already replaced does not reject the new one’s calls', async () => {
  const { workers, workerFactory } = fakeWorkers();
  const reader = createWorkerReader({ workerFactory });
  void settled(reader.open(new ArrayBuffer(1), 'xlsx'));
  const opening = settled(reader.open(new ArrayBuffer(2), 'csv'));
  expect(workers).toHaveLength(2);
  workers[0]!.crash();
  workers[1]!.answer(workers[1]!.received[0]!.id, { sheets: [] });
  expect((await opening).value).toEqual({ sheets: [] });
  expect(workers[1]!.isTerminated).toBe(false);
});
