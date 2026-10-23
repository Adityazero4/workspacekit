import { expect, test } from 'vitest';
import { serveReaderRequests, type ReaderRequest, type ReaderResponse } from '../src/reader/session';
import { DEFAULT_CAPS } from '../src/reader/types';

function fakeScope(failingPosts: number) {
  const listeners: ((event: MessageEvent<ReaderRequest>) => void)[] = [];
  const answers: ReaderResponse[] = [];
  let failuresLeft = failingPosts;
  return {
    answers,
    send: (request: ReaderRequest) => {
      for (const listener of listeners) listener(new MessageEvent('message', { data: request }));
    },
    scope: {
      addEventListener: (_type: 'message', listener: (event: MessageEvent<ReaderRequest>) => void) => {
        listeners.push(listener);
      },
      postMessage: (message: ReaderResponse) => {
        if (failuresLeft-- > 0) throw new Error('DataCloneError');
        answers.push(message);
      },
    },
  };
}

const csvBytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

test('an answer that cannot be sent becomes an error answer, and later requests are still served', async () => {
  const { scope, send, answers } = fakeScope(1);
  serveReaderRequests(scope);
  send({ id: 1, type: 'open', data: csvBytes('a,b'), format: 'csv', caps: DEFAULT_CAPS });
  send({ id: 2, type: 'sheet', index: 0 });
  await expect.poll(() => answers.length).toBe(2);
  expect(answers[0]).toMatchObject({ id: 1, ok: false, error: { kind: 'load_error' } });
  expect(answers[1]).toMatchObject({ id: 2, ok: true });
});

test('even an error answer that cannot be sent leaves the queue running', async () => {
  const { scope, send, answers } = fakeScope(2);
  serveReaderRequests(scope);
  send({ id: 1, type: 'open', data: csvBytes('a,b'), format: 'csv', caps: DEFAULT_CAPS });
  send({ id: 2, type: 'search', index: 0, query: 'b' });
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ id: 2, ok: true, result: [{ row: 0, col: 1 }] });
});
