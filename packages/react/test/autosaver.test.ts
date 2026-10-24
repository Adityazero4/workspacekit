import { FsError, type Entry } from '@workspacekit/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAutosaver, type AutosaverOptions } from '../src/editing/autosaver';

interface HeldSave {
  text: string;
  expectedMtimeMs: number | undefined;
  resolve: (mtimeMs: number) => void;
  reject: (error: unknown) => void;
}

function heldSaves(): { saves: HeldSave[]; save: AutosaverOptions['save'] } {
  const saves: HeldSave[] = [];
  const save: AutosaverOptions['save'] = (text, expectedMtimeMs) =>
    new Promise<Entry>((resolve, reject) => {
      saves.push({
        text,
        expectedMtimeMs,
        resolve: (mtimeMs) => resolve({ path: 'a.txt', name: 'a.txt', kind: 'file', mtimeMs }),
        reject,
      });
    });
  return { saves, save };
}

const settleSave = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('saves the latest text 1000 ms after the last change', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  expect(autosaver.status().kind).toBe('idle');
  autosaver.change('a');
  await vi.advanceTimersByTimeAsync(600);
  autosaver.change('ab');
  expect(autosaver.status().kind).toBe('dirty');
  await vi.advanceTimersByTimeAsync(999);
  expect(saves).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saves.map((held) => held.text)).toEqual(['ab']);
  expect(autosaver.status().kind).toBe('saving');
});

test('text typed during an in-flight save is saved next, never marked saved early', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('first');
  await vi.advanceTimersByTimeAsync(1000);
  expect(saves.map((held) => held.text)).toEqual(['first']);

  autosaver.change('first and more');
  await vi.advanceTimersByTimeAsync(1000);
  expect(saves, 'one save in flight at a time').toHaveLength(1);
  saves[0]!.resolve(2);
  await settleSave();
  expect(autosaver.status().kind).not.toBe('saved');
  expect(saves.map((held) => held.text)).toEqual(['first', 'first and more']);

  saves[1]!.resolve(3);
  await settleSave();
  expect(autosaver.status().kind).toBe('saved');
  expect(autosaver.status().savedAt).toBeTypeOf('number');
});

test('a change during a save back to the text sent still ends saved', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('same');
  await vi.advanceTimersByTimeAsync(1000);
  autosaver.change('same!');
  autosaver.change('same');
  saves[0]!.resolve(2);
  await settleSave();
  expect(autosaver.status().kind).toBe('saved');
  await vi.advanceTimersByTimeAsync(1000);
  expect(saves).toHaveLength(1);
});

test('saves send expectedMtimeMs and rebase on success', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 10 });
  autosaver.change('one');
  void autosaver.flush();
  expect(saves[0]!.expectedMtimeMs).toBe(10);
  saves[0]!.resolve(20);
  await settleSave();

  autosaver.change('two');
  void autosaver.flush();
  expect(saves[1]!.expectedMtimeMs).toBe(20);
  saves[1]!.resolve(30);
  await settleSave();

  autosaver.rebase(99);
  autosaver.change('three');
  void autosaver.flush();
  expect(saves[2]!.expectedMtimeMs).toBe(99);
});

test('flush saves at once and resolves once the save settles', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('now');
  let flushed = false;
  void autosaver.flush().then(() => (flushed = true));
  expect(
    saves.map((held) => held.text),
    'the save starts synchronously',
  ).toEqual(['now']);
  await settleSave();
  expect(flushed).toBe(false);
  saves[0]!.resolve(2);
  await settleSave();
  expect(flushed).toBe(true);
  expect(autosaver.status().kind).toBe('saved');
});

test('conflict stops saving; other errors retry on change or flush', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('a');
  void autosaver.flush();
  const offline = new FsError('network', 'offline');
  saves[0]!.reject(offline);
  await settleSave();
  expect(autosaver.status()).toMatchObject({ kind: 'error', error: offline });

  autosaver.change('ab');
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    saves.map((held) => held.text),
    'retried on the next change',
  ).toEqual(['a', 'ab']);
  saves[1]!.reject(offline);
  await settleSave();
  void autosaver.flush();
  expect(
    saves.map((held) => held.text),
    'retried on flush',
  ).toEqual(['a', 'ab', 'ab']);

  const changedElsewhere = new FsError('conflict', 'modified since read');
  saves[2]!.reject(changedElsewhere);
  await settleSave();
  expect(autosaver.status()).toMatchObject({ kind: 'conflict', error: changedElsewhere });
  autosaver.change('abc');
  await vi.advanceTimersByTimeAsync(5000);
  await autosaver.flush();
  expect(saves, 'nothing saved while in conflict').toHaveLength(3);
  expect(autosaver.status().kind).toBe('conflict');

  autosaver.rebase(7);
  expect(autosaver.status().kind).toBe('dirty');
  void autosaver.flush();
  expect(saves.at(-1)).toMatchObject({ text: 'abc', expectedMtimeMs: 7 });
});

test('subscribers hear status transitions only, not every change', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  const kinds: string[] = [];
  autosaver.subscribe(() => kinds.push(autosaver.status().kind));
  autosaver.change('a');
  autosaver.change('ab');
  autosaver.change('abc');
  await vi.advanceTimersByTimeAsync(1000);
  saves[0]!.resolve(2);
  await settleSave();
  expect(kinds).toEqual(['dirty', 'saving', 'saved']);
});

test('dispose cancels the pending save and silences listeners', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  const listener = vi.fn();
  autosaver.subscribe(listener);
  autosaver.change('a');
  listener.mockClear();
  autosaver.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  autosaver.change('ab');
  expect(saves).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
});

test('dispose during an in-flight save: the save settles silently and nothing more is saved', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  const listener = vi.fn();
  autosaver.subscribe(listener);
  autosaver.change('a');
  void autosaver.flush();
  autosaver.change('ab');
  listener.mockClear();
  autosaver.dispose();
  saves[0]!.resolve(2);
  await settleSave();
  await vi.advanceTimersByTimeAsync(5000);
  await autosaver.flush();
  expect(saves.map((held) => held.text)).toEqual(['a']);
  expect(listener).not.toHaveBeenCalled();
});

test('a save that throws instead of rejecting is an error, and flush still resolves', async () => {
  const autosaver = createAutosaver({
    save: () => {
      throw new FsError('invalid', 'cannot save');
    },
    baseMtimeMs: 1,
  });
  autosaver.change('a');
  await expect(autosaver.flush()).resolves.toBeUndefined();
  expect(autosaver.status()).toMatchObject({ kind: 'error', error: { message: 'cannot save' } });
});

test('a version someone else wrote while edits are unsaved is a conflict: nothing is saved over it', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('mine');
  autosaver.noteServerVersion(5);
  expect(autosaver.status()).toMatchObject({ kind: 'conflict', error: { kind: 'conflict' } });
  await vi.advanceTimersByTimeAsync(5000);
  await autosaver.flush();
  expect(saves).toEqual([]);

  autosaver.noteServerVersion(6);
  expect(autosaver.status().kind, 'a newer version never leaves conflict').toBe('conflict');
  autosaver.rebase(6);
  void autosaver.flush();
  expect(saves.at(-1)).toMatchObject({ text: 'mine', expectedMtimeMs: 6 });
});

test('a version seen while a save is in flight is checked once it settles; the save echo is not a conflict', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('one');
  void autosaver.flush();
  autosaver.change('one more');
  autosaver.noteServerVersion(2);
  saves[0]!.resolve(2);
  await settleSave();
  expect(autosaver.status().kind).toBe('dirty');

  void autosaver.flush();
  autosaver.noteServerVersion(9);
  autosaver.change('one more again');
  saves[1]!.reject(new FsError('conflict', 'modified since read'));
  await settleSave();
  expect(autosaver.status().kind).toBe('conflict');
});

test('with nothing unsaved, a newer server version becomes the base of the next save', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.noteServerVersion(4);
  expect(autosaver.status().kind).toBe('idle');
  autosaver.change('edited after their change');
  void autosaver.flush();
  expect(saves[0]!.expectedMtimeMs).toBe(4);
});

test('discard drops the unsaved text and the pending save, and takes their version as the base', async () => {
  const { saves, save } = heldSaves();
  const autosaver = createAutosaver({ save, baseMtimeMs: 1 });
  autosaver.change('mine');
  autosaver.noteServerVersion(5);
  autosaver.discard(5);
  expect(autosaver.status().kind).toBe('idle');
  await vi.advanceTimersByTimeAsync(5000);
  await autosaver.flush();
  expect(saves).toEqual([]);
  autosaver.change('theirs, edited');
  void autosaver.flush();
  expect(saves[0]).toMatchObject({ text: 'theirs, edited', expectedMtimeMs: 5 });
});
