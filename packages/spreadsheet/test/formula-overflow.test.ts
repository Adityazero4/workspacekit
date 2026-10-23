import { afterEach, expect, test, vi } from 'vitest';
import { openBook } from '../src/reader/engine';
import { DEFAULT_CAPS, newReadWork } from '../src/reader/types';
import { formulaCell, numberCell, sheetData, xlsxBytes } from './support/xlsxFixture';

const engine = vi.hoisted(() => ({
  depth: 0,
  overflowPast: Number.POSITIVE_INFINITY,
  overflow: (): Error => new RangeError('Maximum call stack size exceeded'),
}));

vi.mock('fast-formula-parser', async (importOriginal) => {
  const { default: Engine } = await importOriginal<{
    default: new (config: object) => { parse(...args: unknown[]): unknown };
  }>();
  class OverflowingEngine extends Engine {
    override parse(...args: unknown[]): unknown {
      engine.depth++;
      try {
        if (engine.depth > engine.overflowPast) throw engine.overflow();
        return super.parse(...args);
      } finally {
        engine.depth--;
      }
    }
  }
  return { default: OverflowingEngine };
});

afterEach(() => {
  engine.overflowPast = Number.POSITIVE_INFINITY;
});

const columnLetters = (index: number): string => {
  let letters = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    letters = String.fromCharCode(65 + ((remaining - 1) % 26)) + letters;
  }
  return letters;
};

function firefoxOverflow(): Error {
  const error = new Error('too much recursion');
  error.name = 'InternalError';
  return error;
}

test.each([
  ['a RangeError', () => new RangeError('Maximum call stack size exceeded')],
  ["Firefox's InternalError", firefoxOverflow],
])('an engine stack overflow (%s) defers the cell instead of showing a wrong value', async (_, overflow) => {
  engine.overflowPast = 20;
  engine.overflow = overflow;
  const cells = Array.from({ length: 80 }, (_, index) =>
    formulaCell(
      `${columnLetters(index)}1`,
      `IF(ISERROR(${columnLetters(index + 1)}1),-1000,${columnLetters(index + 1)}1+1)`,
    ),
  );
  cells.push(numberCell(`${columnLetters(80)}1`, 1));
  const book = openBook(
    xlsxBytes({ sheets: [{ name: 'S', body: sheetData([cells]) }] }),
    'xlsx',
    DEFAULT_CAPS,
    newReadWork(),
  );
  const sheet = await book.sheet(0);
  expect(sheet.cellTexts[0]).toBe('81');
  expect(sheet.cellTexts.slice(0, 80).every((text, index) => text === String(81 - index))).toBe(true);
});
