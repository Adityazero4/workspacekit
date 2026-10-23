import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { editReporter } from '../src/editReporter';

const MIB = 1024 * 1024;
const big = (marker: string): string => marker + 'x'.repeat(MIB);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('a document up to 1 MiB is reported at once', () => {
  const deliver = vi.fn<(doc: string) => void>();
  editReporter<string>().changed('x'.repeat(MIB), deliver);
  expect(deliver).toHaveBeenCalledTimes(1);
});

test('a larger document is reported once, 300 ms after the last edit', () => {
  const deliver = vi.fn<(doc: string) => void>();
  const reporter = editReporter<string>();
  reporter.changed(big('a'), deliver);
  vi.advanceTimersByTime(299);
  reporter.changed(big('b'), deliver);
  vi.advanceTimersByTime(299);
  expect(deliver).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(deliver).toHaveBeenCalledExactlyOnceWith(big('b'));
});

test('flush reports a pending edit now, once, and does nothing when none is pending', () => {
  const deliver = vi.fn<(doc: string) => void>();
  const reporter = editReporter<string>();
  reporter.flush();
  reporter.changed(big('a'), deliver);
  reporter.flush();
  vi.advanceTimersByTime(1000);
  reporter.flush();
  expect(deliver).toHaveBeenCalledExactlyOnceWith(big('a'));
});

test('a pending batch goes to the deliver given with its first edit; the next batch to its own', () => {
  const first = vi.fn<(doc: string) => void>();
  const second = vi.fn<(doc: string) => void>();
  const reporter = editReporter<string>();
  reporter.changed(big('a'), first);
  reporter.changed(big('b'), second);
  reporter.flush();
  reporter.changed(big('c'), second);
  reporter.flush();
  expect(first).toHaveBeenCalledExactlyOnceWith(big('b'));
  expect(second).toHaveBeenCalledExactlyOnceWith(big('c'));
});
