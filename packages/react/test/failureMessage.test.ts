import { FsError } from '@workspacekit/core';
import { expect, test } from 'vitest';
import { failureMessage } from '../src/provider/hooks';

test('the reason loses its closing periods, so the sentence ends in one', () => {
  expect(failureMessage('Search failed', new FsError('network', 'The service is down...'))).toBe(
    'Search failed: The service is down. Try again.',
  );
});

test('a long run of dots formats in linear time and is cut at 500 characters', () => {
  const message = `${'.'.repeat(100_000)}x`;
  const startedAt = performance.now();
  const formatted = failureMessage('Search failed', new FsError('unknown', message));
  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(formatted.startsWith(`Search failed: ${'.'.repeat(500)}…`)).toBe(true);
  expect(formatted.length).toBeLessThan(600);
});
