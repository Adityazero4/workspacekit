import { isSameOrDescendant, parentPath } from './path';

export type NameProblem = 'empty' | 'invalid_chars' | 'reserved' | 'too_long' | 'duplicate';

/** `ext` includes the dot; leading-dot names (`.env`) and extensionless names have `ext: ''`. */
export function splitName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, i), ext: name.slice(i) };
}

// Duplicates are NFC-normalized, joiner-folded and case-insensitive (safe on macOS/Windows).
const key = (n: string): string => n.normalize('NFC').replace(/[\u200C\u200D]/g, '').toLowerCase();

export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const keys = new Set([...taken].map(key));
  if (!keys.has(key(name))) return name;
  const { stem, ext } = splitName(name);
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`;
    if (!keys.has(key(candidate))) return candidate;
  }
}

// Separators, control chars, and every format (Cf) or line/paragraph separator, plus Hangul/braille/CGJ fillers that Cf misses.
// ZWJ and ZWNJ (U+200D, U+200C) are stripped before this test: emoji sequences and Persian/Indic words need them,
// but only between two non-ASCII code points (see hasStrayJoiner), so they can't disguise ASCII names.
// Tag characters (U+E0000-U+E007F) are rejected on purpose: they can smuggle invisible text into names shown to agents.
const INVALID_CHARS = /[\/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\u034F\u{E0000}-\u{E007F}]/u;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** True if a ZWNJ/ZWJ has a missing or ASCII neighbour. Iterates code points so astral emoji count as one. */
function hasStrayJoiner(name: string): boolean {
  const cps = Array.from(name, (c) => c.codePointAt(0)!);
  return cps.some((c, i) => (c === 0x200c || c === 0x200d) && ((cps[i - 1] ?? 0) <= 0x7f || (cps[i + 1] ?? 0) <= 0x7f));
}

export function validateName(rawName: string, siblings: ReadonlySet<string>): NameProblem | null {
  const name = rawName.normalize('NFC');
  const visible = name.replace(/[\u200C\u200D]/g, '');
  if (visible.trim() === '') return 'empty';
  if (hasStrayJoiner(name) || INVALID_CHARS.test(visible)) return 'invalid_chars';
  if (name === '.' || name === '..' || /[. ]$/.test(name) || RESERVED.test(name)) return 'reserved';
  if (new TextEncoder().encode(name).length > 255) return 'too_long';
  const k = key(name);
  for (const s of siblings) if (key(s) === k) return 'duplicate';
  return null;
}

/** `from` and `toDir` must be normalized paths. */
export function validateTransfer(
  op: 'move' | 'copy',
  from: string,
  toDir: string,
): 'into_self' | 'noop' | null {
  if (isSameOrDescendant(toDir, from)) return 'into_self';
  return op === 'move' && parentPath(from) === toDir ? 'noop' : null;
}
