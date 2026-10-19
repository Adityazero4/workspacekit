import { expect, test, vi } from 'vitest';
import { createUiStore } from '../src/provider/ui-store';

test('set notifies once per change and skips identical values', () => {
  const s = createUiStore(1);
  const l = vi.fn();
  const off = s.subscribe(l);
  s.set(2);
  s.set((n) => n + 1);
  s.set(3);
  expect(s.get()).toBe(3);
  expect(l).toHaveBeenCalledTimes(2);
  off();
  s.set(4);
  expect(l).toHaveBeenCalledTimes(2);
});

test('snapshots are immutable: an updater gets the previous value', () => {
  const s = createUiStore<ReadonlySet<string>>(new Set());
  const before = s.get();
  s.set((prev) => new Set(prev).add('a'));
  expect(before.size).toBe(0);
  expect([...s.get()]).toEqual(['a']);
});
