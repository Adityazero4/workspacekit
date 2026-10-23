import type { ReaderCaps } from './types';

const QUOTE = '"';
const LINE_FEED = '\n';
const CARRIAGE_RETURN = '\r';

function boundedWriter(text: string) {
  const kept: string[] = [];
  let keptFrom = 0;
  let isKeeping = true;
  return {
    pause: (at: number): void => {
      if (!isKeeping) return;
      kept.push(text.slice(keptFrom, at));
      isKeeping = false;
    },
    resume: (at: number): void => {
      if (isKeeping) return;
      keptFrom = at;
      isKeeping = true;
    },
    finish: (at: number): string => {
      if (isKeeping) kept.push(text.slice(keptFrom, at));
      return kept.join('');
    },
  };
}

function scanState(caps: ReaderCaps) {
  return {
    caps,
    isQuoted: false,
    fieldLength: 0,
    isFieldCut: false,
    fields: 0,
    isRowCut: false,
    rows: 0,
    cells: 0,
    isCut: false,
  };
}

type ScanState = ReturnType<typeof scanState>;

function countCharacter(state: ScanState, writer: ReturnType<typeof boundedWriter>, at: number): void {
  if (++state.fieldLength > state.caps.maxCellText && !state.isFieldCut) {
    state.isFieldCut = true;
    state.isCut = true;
    writer.pause(at);
  }
}

function endField(state: ScanState, writer: ReturnType<typeof boundedWriter>, at: number): void {
  state.fieldLength = 0;
  state.isFieldCut = false;
  if (!state.isRowCut) writer.resume(at);
}

function onDelimiter(state: ScanState, writer: ReturnType<typeof boundedWriter>, at: number): void {
  state.fields++;
  state.cells++;
  endField(state, writer, at);
  if (state.fields < state.caps.maxCols || state.isRowCut) return;
  state.isRowCut = true;
  state.isCut = true;
  writer.pause(at);
}

function onLineFeed(state: ScanState, writer: ReturnType<typeof boundedWriter>, at: number): boolean {
  state.rows++;
  state.cells++;
  state.fields = 0;
  state.isRowCut = false;
  endField(state, writer, at);
  return state.rows <= state.caps.maxRows && state.cells <= state.caps.maxCells;
}

/**
 * Cuts delimited text down to what the sheet can show before papaparse sees it, in one linear pass that
 * follows quoting (`""` inside quotes is one character) and every line ending (LF, CRLF and a lone CR):
 * a field keeps at most `caps.maxCellText`
 * characters, a row at most `caps.maxCols` fields, and the text stops after `caps.maxRows` rows or
 * `caps.maxCells` fields. So a megabyte-long field, or a row of millions of commas, never becomes millions
 * of strings. `isCut` says something was left out.
 *
 * @example
 * ```ts
 * boundedDelimitedText('a,b,c\n1,2,3', ',', { ...DEFAULT_CAPS, maxCols: 2 });
 * // { text: 'a,b\n1,2', isCut: true }
 * ```
 */
export function boundedDelimitedText(
  text: string,
  delimiter: string,
  caps: ReaderCaps,
): { text: string; isCut: boolean } {
  const writer = boundedWriter(text);
  const state = scanState(caps);
  let index = 0;
  for (; index < text.length; index++) {
    const character = text[index];
    if (state.isQuoted) {
      if (character !== QUOTE) countCharacter(state, writer, index);
      else if (text[index + 1] === QUOTE) countCharacter(state, writer, index++);
      else {
        state.isQuoted = false;
        if (state.isFieldCut && !state.isRowCut) writer.resume(index);
      }
    } else if (character === QUOTE && state.fieldLength === 0) state.isQuoted = true;
    else if (character === delimiter) onDelimiter(state, writer, index);
    else if (character === CARRIAGE_RETURN && text[index + 1] === LINE_FEED) continue;
    else if (character === LINE_FEED || character === CARRIAGE_RETURN) {
      if (!onLineFeed(state, writer, index)) {
        state.isCut = true;
        break;
      }
    } else countCharacter(state, writer, index);
  }
  return { text: writer.finish(index), isCut: state.isCut };
}
