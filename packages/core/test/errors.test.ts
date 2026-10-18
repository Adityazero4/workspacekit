import { expect, test } from 'vitest';
import { FsError, isFsError, kindForStatus, statusForKind, toFsError } from '../src/errors';

test('toFsError maps AbortError to cancelled and status codes to kinds', () => {
  expect(toFsError(new DOMException('x', 'AbortError')).kind).toBe('cancelled');
  expect(kindForStatus(409)).toBe('conflict');
  expect(statusForKind('too_large')).toBe(413);
});

test('toFsError other mappings', () => {
  expect(toFsError(new TypeError('Failed to fetch')).kind).toBe('network');
  expect(toFsError(new Error('boom')).kind).toBe('unknown');
  expect(toFsError('str').kind).toBe('unknown');
  const e = new FsError('not_found', 'nope', { status: 404, path: 'a' });
  expect(toFsError(e)).toBe(e);
  expect(isFsError(e)).toBe(true);
  expect(isFsError(new Error('x'))).toBe(false);
  expect(e.status).toBe(404);
  expect(e.path).toBe('a');
});

test('status <-> kind round trip', () => {
  for (const [kind, status] of [
    ['invalid', 400], ['forbidden', 403], ['not_found', 404], ['conflict', 409],
    ['too_large', 413], ['unknown', 500], ['timeout', 504],
  ] as const) {
    expect(statusForKind(kind)).toBe(status);
    expect(kindForStatus(status)).toBe(kind);
  }
  expect(kindForStatus(408)).toBe('timeout');
  expect(kindForStatus(401)).toBe('forbidden');
  expect(kindForStatus(418)).toBe('unknown');
  expect(statusForKind('network')).toBe(500);
  expect(statusForKind('cancelled')).toBe(500);
});
