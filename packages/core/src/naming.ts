import { isSameOrDescendant, parentPath } from './path';

/**
 * Why `validateName` rejects a name.
 *
 * @example
 * ```ts
 * const message = problem === 'duplicate' ? 'That name is taken' : 'Pick another name';
 * ```
 */
export type NameProblem = 'empty' | 'invalid_chars' | 'reserved' | 'too_long' | 'duplicate';

/**
 * `ext` includes the dot; leading-dot names (`.env`) and extensionless names have `ext: ''`.
 *
 * @example
 * ```ts
 * splitName('archive.tar.gz'); // { stem: 'archive.tar', ext: '.gz' }
 * ```
 */
export function splitName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, i), ext: name.slice(i) };
}

const JOINERS = /[\u200C\u200D]/g;

const caseAndJoinerInsensitiveKey = (name: string): string =>
  name.normalize('NFC').replace(JOINERS, '').toLowerCase();

/**
 * `name` if it is free among `taken`, else the first free `name copy`, `name copy 2`, … keeping the
 * extension. Names are compared like `validateName` compares duplicates.
 *
 * @example
 * ```ts
 * uniqueName('a.txt', new Set(['a.txt'])); // 'a copy.txt'
 * ```
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const takenKeys = new Set([...taken].map(caseAndJoinerInsensitiveKey));
  if (!takenKeys.has(caseAndJoinerInsensitiveKey(name))) return name;
  const { stem, ext } = splitName(name);
  for (let copyNumber = 1; ; copyNumber++) {
    const candidate = `${stem} copy${copyNumber === 1 ? '' : ` ${copyNumber}`}${ext}`;
    if (!takenKeys.has(caseAndJoinerInsensitiveKey(candidate))) return candidate;
  }
}

const SEPARATORS_CONTROLS_FORMATS_AND_FILLERS =
  // eslint-disable-next-line no-misleading-character-class -- U+034F is listed on purpose: alone it is an invisible filler
  /[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\u034F\u{E0000}-\u{E007F}]/u;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_BYTES = 255;
const LAST_ASCII_CODE_POINT = 0x7f;

const isJoiner = (codePoint: number): boolean => codePoint === 0x200c || codePoint === 0x200d;

function hasJoinerNextToAsciiOrEdge(name: string): boolean {
  const codePoints = Array.from(name, (char) => char.codePointAt(0)!);
  const isAsciiOrEdge = (at: number): boolean => (codePoints[at] ?? 0) <= LAST_ASCII_CODE_POINT;
  return codePoints.some(
    (codePoint, at) => isJoiner(codePoint) && (isAsciiOrEdge(at - 1) || isAsciiOrEdge(at + 1)),
  );
}

/**
 * Checks a new entry name against `siblings`. Rejects separators, control and format characters, invisible
 * fillers and Unicode tag characters (they can smuggle invisible text into names shown to agents). ZWJ and
 * ZWNJ are allowed only between two non-ASCII characters, as emoji sequences and Persian or Indic words need
 * them, so they cannot disguise an ASCII name. Duplicates are compared NFC-normalized, joiner-free and
 * case-insensitively, which is safe on macOS and Windows.
 *
 * @returns The problem, or `null` when the name is valid.
 *
 * @example
 * ```ts
 * validateName('notes.md', new Set(['Notes.md'])); // 'duplicate'
 * ```
 */
export function validateName(rawName: string, siblings: ReadonlySet<string>): NameProblem | null {
  const name = rawName.normalize('NFC');
  const withoutJoiners = name.replace(JOINERS, '');
  if (withoutJoiners.trim() === '') return 'empty';
  if (hasJoinerNextToAsciiOrEdge(name) || SEPARATORS_CONTROLS_FORMATS_AND_FILLERS.test(withoutJoiners)) {
    return 'invalid_chars';
  }
  if (name === '.' || name === '..' || /[. ]$/.test(name) || WINDOWS_RESERVED_NAME.test(name)) {
    return 'reserved';
  }
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'too_long';
  const nameKey = caseAndJoinerInsensitiveKey(name);
  for (const sibling of siblings) if (caseAndJoinerInsensitiveKey(sibling) === nameKey) return 'duplicate';
  return null;
}

/**
 * `from` and `toDir` must be normalized paths.
 *
 * @example
 * ```ts
 * validateTransfer('move', 'src', 'src/app'); // 'into_self'
 * ```
 */
export function validateTransfer(
  op: 'move' | 'copy',
  from: string,
  toDir: string,
): 'into_self' | 'noop' | null {
  if (isSameOrDescendant(toDir, from)) return 'into_self';
  return op === 'move' && parentPath(from) === toDir ? 'noop' : null;
}
