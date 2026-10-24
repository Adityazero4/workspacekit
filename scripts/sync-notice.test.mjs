import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { staleLegalFiles } from './sync-notice.mjs';

function repo(copies) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sync-notice-'));
  mkdirSync(path.join(root, 'packages', 'core'), { recursive: true });
  writeFileSync(path.join(root, 'NOTICE'), 'notice');
  writeFileSync(path.join(root, 'LICENSE'), 'license');
  for (const [name, text] of Object.entries(copies)) {
    writeFileSync(path.join(root, 'packages', 'core', name), text);
  }
  return root;
}

test('accepts identical copies', () => {
  assert.deepEqual(staleLegalFiles(repo({ NOTICE: 'notice', LICENSE: 'license' }), ['core']), []);
});

test('reports a missing copy', () => {
  assert.deepEqual(staleLegalFiles(repo({ LICENSE: 'license' }), ['core']), ['packages/core/NOTICE']);
});

test('reports a copy that differs', () => {
  assert.deepEqual(staleLegalFiles(repo({ NOTICE: 'old', LICENSE: 'license' }), ['core']), [
    'packages/core/NOTICE',
  ]);
});
