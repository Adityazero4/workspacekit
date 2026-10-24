import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFsError, type FsErrorKind } from '@workspacekit/core';
import { resolveInRoot } from '../src/jail';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'jail-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'real'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'real', 'f.txt'), 'f');
  await writeFile(path.join(outside, 'secret.txt'), 's');
  await symlink(outside, path.join(root, 'link'));
  await symlink(path.join(root, 'real'), path.join(root, 'alias'));
  await symlink(path.join(base, 'nowhere'), path.join(root, 'dangling'));
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function kind(p: Promise<unknown>): Promise<FsErrorKind | undefined> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  return isFsError(e) ? e.kind : undefined;
}

describe('resolveInRoot', () => {
  it('rejects .., absolute, NUL', async () => {
    for (const bad of [
      '../outside/secret.txt',
      'real/../../outside',
      '/etc/passwd',
      'real/a\0b',
      'real\\..\\x',
    ]) {
      expect(['forbidden', 'invalid']).toContain(await kind(resolveInRoot(root, bad)));
    }
  });

  it('rejects symlink escape', async () => {
    expect(await kind(resolveInRoot(root, 'link'))).toBe('forbidden');
    expect(await kind(resolveInRoot(root, 'link/secret.txt'))).toBe('forbidden');
    expect(await kind(resolveInRoot(root, 'link/secret.txt', { forCreate: true }))).toBe('forbidden');
  });

  it('allows symlink inside root', async () => {
    expect(await resolveInRoot(root, 'alias/f.txt')).toBe(path.join(root, 'real', 'f.txt'));
    // the final link itself is kept, so delete/move act on the link
    expect(await resolveInRoot(root, 'alias')).toBe(path.join(root, 'alias'));
  });

  it('forCreate checks the deepest existing ancestor', async () => {
    expect(await kind(resolveInRoot(root, 'link/new.txt', { forCreate: true }))).toBe('forbidden');
    expect(await kind(resolveInRoot(root, 'link/a/b/new.txt', { forCreate: true }))).toBe('forbidden');
    expect(await kind(resolveInRoot(root, 'dangling/x', { forCreate: true }))).toBe('forbidden');
    expect(await resolveInRoot(root, 'real/a/b.txt', { forCreate: true })).toBe(
      path.join(root, 'real', 'a', 'b.txt'),
    );
    expect(await resolveInRoot(root, 'alias/new.txt', { forCreate: true })).toBe(
      path.join(root, 'real', 'new.txt'),
    );
  });

  it('requires existence unless forCreate; the root is allowed', async () => {
    expect(await kind(resolveInRoot(root, 'real/missing.txt'))).toBe('not_found');
    expect(await kind(resolveInRoot(root, 'real/f.txt/below'))).toBe('not_found');
    expect(await resolveInRoot(root, '')).toBe(root);
  });
});
