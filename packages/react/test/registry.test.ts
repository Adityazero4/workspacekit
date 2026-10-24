import type { Entry } from '@workspacekit/core';
import { expect, test } from 'vitest';
import {
  defineRenderer,
  fileInfo,
  MATCH_SCORE,
  resolveRenderer,
  viewerError,
  type Renderer,
  type ViewerErrorKind,
} from '../src/viewer/registry';

const fileNamed = (name: string): Entry => ({ path: `dir/${name}`, name, kind: 'file' });
const directoryNamed = (name: string): Entry => ({ path: name, name, kind: 'directory' });

const rendererScoring = (id: string, score: number | false): Renderer =>
  defineRenderer({ id, match: () => score, load: () => Promise.reject(new Error('unused')), input: 'none' });

test('fileInfo lower-cases extension and basename; dotfiles and extensionless names have extension ""', () => {
  expect(fileInfo(fileNamed('Makefile'))).toMatchObject({ extension: '', basename: 'makefile' });
  expect(fileInfo(fileNamed('.env'))).toMatchObject({ extension: '', basename: '.env' });
  expect(fileInfo(fileNamed('a.TAR.GZ'))).toMatchObject({ extension: 'gz', basename: 'a.tar.gz' });
});

test('highest score wins; ties go to the earlier renderer', () => {
  const low = rendererScoring('low', MATCH_SCORE.text);
  const firstHigh = rendererScoring('first-high', MATCH_SCORE.specific);
  const secondHigh = rendererScoring('second-high', MATCH_SCORE.specific);
  expect(resolveRenderer(fileNamed('a.txt'), [low, firstHigh, secondHigh])?.id).toBe('first-high');
  expect(resolveRenderer(fileNamed('a.txt'), [secondHigh, firstHigh, low])?.id).toBe('second-high');
});

test('a directory renderer beats any file renderer', () => {
  const directory = rendererScoring('directory', MATCH_SCORE.directory);
  const specific = rendererScoring('specific', MATCH_SCORE.specific);
  expect(resolveRenderer(directoryNamed('src'), [specific, directory])?.id).toBe('directory');
});

test('match returning false is skipped; no match returns undefined', () => {
  const never = rendererScoring('never', false);
  const fallback = rendererScoring('fallback', MATCH_SCORE.fallback);
  expect(resolveRenderer(fileNamed('a.bin'), [never, fallback])?.id).toBe('fallback');
  expect(resolveRenderer(fileNamed('a.bin'), [never])).toBeUndefined();
  expect(resolveRenderer(fileNamed('a.bin'), [])).toBeUndefined();
});

test('viewerError gives the copy for each kind', () => {
  const copy: Array<[ViewerErrorKind, string]> = [
    ['not_found', 'This file no longer exists. It may have been moved or deleted.'],
    ['load_error', "This file couldn't be opened. Try again, or download it."],
    ['password_protected', "This file is password-protected and can't be previewed. Download it to open it."],
    ['unsupported_media', "Your browser can't play this format. Download it to open it in another app."],
    ['too_large', 'This file is too large to preview. Download it instead.'],
    ['deleted', 'This file was deleted.'],
  ];
  for (const [kind, message] of copy) {
    expect(viewerError(kind)).toEqual({ kind, message });
  }
  const cause = new Error('boom');
  expect(viewerError('load_error', cause).cause).toBe(cause);
});
