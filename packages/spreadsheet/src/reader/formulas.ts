import type FormulaParser from 'fast-formula-parser';
import { detachedPrefix, type ReadWork, type ReaderCaps } from './types';
import { shiftFormula } from './shiftFormula';
import type { RawCell, RawSheet } from './xlsx/sheet';

const DEEPEST_FORMULA_CHAIN = 64;
const COLUMN_STRIDE = 1 << 14;
const REFERENCE_ERROR = '#REF!';
const VALUE_ERROR = '#VALUE!';
const ENGINE_ERROR = '#ERROR!';

/**
 * The workbook as formula evaluation sees it: sheet names in order, and each sheet read on demand, so a
 * cross-sheet reference reads only the sheets it names.
 *
 * @example
 * ```ts
 * const book: FormulaBook = { sheetNames: ['Sheet1'], rawSheet: () => sheet };
 * ```
 */
export interface FormulaBook {
  sheetNames: readonly string[];
  rawSheet: (index: number) => RawSheet;
}

type Parser = InstanceType<typeof FormulaParser>;
type ParserClass = typeof FormulaParser;
type Position = { row: number; col: number };

/**
 * True when a cell has a formula whose result the file did not store.
 *
 * @example
 * ```ts
 * const cell = { row: 0, col: 0, kind: 'text', value: undefined, styleIndex: 0, isCached: false } as const;
 * needsEvaluation({ ...cell, formula: 'A2' }); // true
 * ```
 */
export const needsEvaluation = (cell: RawCell): boolean =>
  !cell.isCached && (cell.formula !== undefined || cell.sharedFormula !== undefined);

function formulaTextOf(sheet: RawSheet, cell: RawCell): string | undefined {
  if (cell.formula !== undefined) return cell.formula;
  const master = cell.sharedFormula === undefined ? undefined : sheet.sharedFormulas.get(cell.sharedFormula);
  return master && shiftFormula(master.formula, cell.row - master.row, cell.col - master.col);
}

class Deferral extends Error {
  constructor(
    readonly sheetIndex: number,
    readonly cell: RawCell,
  ) {
    super('A formula chain went too deep; it is evaluated from its deep end first.');
  }
}

function parsed(parser: Parser, formula: string, position: { sheet: string } & Position): unknown {
  try {
    return parser.parse(formula, position);
  } catch (error) {
    const details = (error as { details?: unknown } | null)?.details;
    return typeof (details as { error?: unknown } | null)?.error === 'string' ? details : error;
  }
}

const isOverflowError = (error: unknown): boolean =>
  error instanceof RangeError || (error instanceof Error && error.name === 'InternalError');

const isStackOverflow = (result: unknown): boolean =>
  isOverflowError(result) || isOverflowError((result as { details?: unknown } | null)?.details);

function resultOf(
  parser: Parser,
  formula: string,
  position: { sheet: string } & Position,
  state: EvaluationState,
  evaluating: { sheetIndex: number; cell: RawCell },
): unknown {
  const result = parsed(parser, formula, position);
  if (state.pendingDeferral) throw state.pendingDeferral;
  if (isStackOverflow(result) && !state.deferred.has(evaluating.cell)) {
    throw (state.pendingDeferral = new Deferral(evaluating.sheetIndex, evaluating.cell));
  }
  return result;
}

function cellLookup(
  book: FormulaBook,
): (sheetIndex: number, row: number, col: number) => RawCell | undefined {
  const indexes = new Map<number, Map<number, RawCell>>();
  return (sheetIndex, row, col) => {
    let index = indexes.get(sheetIndex);
    if (!index) {
      index = new Map(
        book.rawSheet(sheetIndex).cells.map((cell) => [cell.row * COLUMN_STRIDE + cell.col, cell]),
      );
      indexes.set(sheetIndex, index);
    }
    return index.get(row * COLUMN_STRIDE + col);
  };
}

function cappedRept(Formula: ParserClass, caps: ReaderCaps) {
  const { FormulaHelpers: helpers, Types: types } = Formula;
  return (text: unknown, times: unknown): string => {
    const repeated = String(helpers.accept(text, types.STRING));
    const count = Math.trunc(Number(helpers.accept(times, types.NUMBER)));
    if (!(count >= 0) || repeated.length * count > caps.maxCellText) {
      throw new Formula.FormulaError(VALUE_ERROR);
    }
    return repeated.repeat(count);
  };
}

function extremeOf(Formula: ParserClass, pick: (a: number, b: number) => number) {
  const { FormulaHelpers: helpers, Types: types } = Formula;
  return (...values: unknown[]): number => {
    let extreme: number | undefined;
    helpers.flattenParams(values, types.NUMBER, true, (item) => {
      if (item instanceof Formula.FormulaError) throw item;
      if (typeof item === 'number') extreme = extreme === undefined ? item : pick(extreme, item);
    });
    return extreme ?? 0;
  };
}

interface EvaluationState {
  done: Set<RawCell>;
  leftEmpty: Set<RawCell>;
  chain: RawCell[];
  deferred: Set<RawCell>;
  pendingDeferral: Deferral | undefined;
  isCutShort: boolean;
}

function storeResult(
  cell: RawCell,
  result: unknown,
  state: EvaluationState,
  caps: ReaderCaps,
  work: ReadWork,
): void {
  const error = (result as { error?: unknown } | null)?.error;
  if (state.leftEmpty.has(cell)) Object.assign(cell, { kind: 'text', value: undefined });
  else if (typeof error === 'string') Object.assign(cell, { kind: 'error', value: error });
  else if (typeof result === 'number') Object.assign(cell, { kind: 'number', value: result });
  else if (typeof result === 'boolean') Object.assign(cell, { kind: 'boolean', value: result });
  else if (typeof result === 'string') {
    work.formulaText += result.length;
    const isWithinBudget = work.formulaText <= caps.maxSheetText;
    if (!isWithinBudget) state.isCutShort = true;
    Object.assign(cell, {
      kind: 'text',
      value: isWithinBudget ? detachedPrefix(result, caps.maxCellText) : undefined,
    });
  } else if (result instanceof Error) Object.assign(cell, { kind: 'error', value: ENGINE_ERROR });
  else Object.assign(cell, { kind: 'number', value: 0 });
}

const isOverBudget = (caps: ReaderCaps, work: ReadWork): boolean =>
  work.formulaCells >= caps.maxFormulaWork || work.formulaText > caps.maxSheetText;

function leaveChainEmpty(state: EvaluationState, from = 0): void {
  for (const member of state.chain.slice(from)) state.leftEmpty.add(member);
}

function cutShort(state: EvaluationState): void {
  state.isCutShort = true;
  leaveChainEmpty(state);
}

function valueReader(
  Formula: ParserClass,
  book: FormulaBook,
  caps: ReaderCaps,
  work: ReadWork,
  state: EvaluationState,
  evaluate: (sheetIndex: number, cell: RawCell) => void,
): (sheetIndex: number, row: number, col: number) => unknown {
  const cellAt = cellLookup(book);
  return (sheetIndex, row, col) => {
    if (state.pendingDeferral) throw state.pendingDeferral;
    if (isOverBudget(caps, work)) {
      cutShort(state);
      return null;
    }
    work.formulaCells++;
    if (sheetIndex < 0) return new Formula.FormulaError(REFERENCE_ERROR);
    let cell: RawCell | undefined;
    try {
      cell = cellAt(sheetIndex, row, col);
    } catch {
      return new Formula.FormulaError(REFERENCE_ERROR);
    }
    if (!cell) return null;
    evaluate(sheetIndex, cell);
    if (state.leftEmpty.has(cell)) leaveChainEmpty(state);
    if (cell.kind === 'error' && typeof cell.value === 'string') return new Formula.FormulaError(cell.value);
    if (typeof cell.value === 'string') work.formulaText += cell.value.length;
    return cell.value ?? null;
  };
}

function rangeReader(
  Formula: ParserClass,
  book: FormulaBook,
  limits: { caps: ReaderCaps; work: ReadWork; state: EvaluationState },
  valueAt: (sheetIndex: number, row: number, col: number) => unknown,
): (sheetIndex: number, from: Position, to: Position) => unknown[][] {
  const { caps, work, state } = limits;
  return (sheetIndex, from, to) => {
    let sheet: RawSheet | undefined;
    try {
      sheet = sheetIndex < 0 ? undefined : book.rawSheet(sheetIndex);
    } catch {
      sheet = undefined;
    }
    if (!sheet) throw new Formula.FormulaError(REFERENCE_ERROR);
    const lastRow = Math.min(to.row, sheet.rowCount);
    const lastCol = Math.min(to.col, sheet.colCount);
    if (state.pendingDeferral) throw state.pendingDeferral;
    if (lastRow < from.row || lastCol < from.col) return [[null]];
    const cellCount = (lastRow - from.row + 1) * (lastCol - from.col + 1);
    if (isOverBudget(caps, work) || work.formulaCells + cellCount > caps.maxFormulaWork) {
      cutShort(state);
      return [[null]];
    }
    const rows: unknown[][] = [];
    for (let row = from.row; row <= lastRow; row++) {
      const values: unknown[] = [];
      for (let col = from.col; col <= lastCol; col++) {
        work.formulaRangeCells++;
        values.push(valueAt(sheetIndex, row - 1, col - 1));
      }
      rows.push(values);
    }
    return rows;
  };
}

function createEvaluator(Formula: ParserClass, book: FormulaBook, caps: ReaderCaps, work: ReadWork) {
  const state: EvaluationState = {
    done: new Set(),
    leftEmpty: new Set(),
    chain: [],
    deferred: new Set(),
    pendingDeferral: undefined,
    isCutShort: false,
  };
  const parsers: Parser[] = [];
  const sheetIndexOf = (name: string): number =>
    book.sheetNames.findIndex((sheetName) => sheetName.toLowerCase() === name.toLowerCase());
  const valueAt = valueReader(Formula, book, caps, work, state, (sheetIndex, cell) =>
    evaluate(sheetIndex, cell),
  );
  const rangeValues = rangeReader(Formula, book, { caps, work, state }, valueAt);
  const newParser = (): Parser =>
    new Formula({
      onCell: (reference) => valueAt(sheetIndexOf(reference.sheet), reference.row - 1, reference.col - 1),
      onRange: (reference) => rangeValues(sheetIndexOf(reference.sheet), reference.from, reference.to),
      functions: {
        REPT: cappedRept(Formula, caps),
        MAX: extremeOf(Formula, Math.max),
        MIN: extremeOf(Formula, Math.min),
      },
    });
  function evaluate(sheetIndex: number, cell: RawCell): void {
    if (!needsEvaluation(cell) || state.done.has(cell)) return;
    const inChain = state.chain.indexOf(cell);
    if (inChain !== -1) return leaveChainEmpty(state, inChain);
    const formula = formulaTextOf(book.rawSheet(sheetIndex), cell);
    if (state.chain.length >= DEEPEST_FORMULA_CHAIN) {
      if (!state.deferred.has(cell)) throw (state.pendingDeferral = new Deferral(sheetIndex, cell));
      leaveChainEmpty(state);
      state.leftEmpty.add(cell);
    }
    const isSpent = isOverBudget(caps, work);
    if (isSpent) state.isCutShort = true;
    if (!formula || isSpent) state.leftEmpty.add(cell);
    state.chain.push(cell);
    const parser = (parsers[state.chain.length - 1] ??= newParser());
    const position = { sheet: book.sheetNames[sheetIndex]!, row: cell.row + 1, col: cell.col + 1 };
    const result = state.leftEmpty.has(cell)
      ? undefined
      : resultOf(parser, formula!, position, state, { sheetIndex, cell });
    state.chain.pop();
    state.done.add(cell);
    storeResult(cell, result, state, caps, work);
  }
  return { evaluate, state };
}

function evaluateFrom(
  roots: { sheetIndex: number; cell: RawCell }[],
  evaluator: ReturnType<typeof createEvaluator>,
): void {
  const { evaluate, state } = evaluator;
  while (roots.length > 0) {
    const root = roots[roots.length - 1]!;
    try {
      evaluate(root.sheetIndex, root.cell);
      roots.pop();
    } catch (thrown) {
      state.chain.length = 0;
      state.pendingDeferral = undefined;
      if (thrown instanceof Deferral && !state.deferred.has(thrown.cell)) {
        state.deferred.add(thrown.cell);
        roots.push({ sheetIndex: thrown.sheetIndex, cell: thrown.cell });
      } else {
        state.leftEmpty.add(root.cell);
        state.done.add(root.cell);
        Object.assign(root.cell, { kind: 'error', value: ENGINE_ERROR });
        roots.pop();
      }
    }
  }
}

/**
 * Evaluates the formulas of `sheetIndex` whose results the file did not store (files written by
 * openpyxl or xlsxwriter often have none). `fast-formula-parser` is imported only when such a formula
 * exists. Results are memoised; a cycle leaves every cell in it empty; a range is clamped to its sheet's
 * extent, so `A:A` reads only the rows that exist; references to other sheets read those sheets, and a
 * missing or unreadable sheet gives `#REF!`. Errors keep their text (`#DIV/0!`).
 *
 * Work is bounded: every cell a formula reads counts against `caps.maxFormulaWork`, and every character of
 * text formulas read or make against `caps.maxSheetText`; a text result is cut at `caps.maxCellText`, and
 * `REPT` past it is `#VALUE!`. Text is charged at its full length before it is cut, so a formula that
 * builds millions of characters spends the budget at once, and a range is not built at all once the budget
 * cannot cover it. A chain more than 64 formulas deep is evaluated from its deep end first, even through
 * `IFERROR` and `ISERROR` (an engine stack overflow, a `RangeError` or Firefox's `InternalError`, is
 * handled the same way); a cell that cannot be evaluated within the limits is left empty, and so is every
 * formula depending on it, so no cell shows a wrong value. A cycle, however long, leaves its cells empty
 * without marking the sheet cut short; resolves to `true` only when the work or text budget left cells
 * empty. `MAX` and `MIN` are provided here, as the engine leaves them unimplemented.
 * A formula the engine fails on shows `#ERROR!` without failing the sheet.
 *
 * @example
 * ```ts
 * await evaluateFormulas(book, 0, caps, work);
 * ```
 */
export async function evaluateFormulas(
  book: FormulaBook,
  sheetIndex: number,
  caps: ReaderCaps,
  work: ReadWork,
): Promise<boolean> {
  const pending = book.rawSheet(sheetIndex).cells.filter(needsEvaluation);
  if (pending.length === 0) return false;
  const { default: Formula } = await import('fast-formula-parser');
  const evaluator = createEvaluator(Formula, book, caps, work);
  for (const cell of pending) evaluateFrom([{ sheetIndex, cell }], evaluator);
  return evaluator.state.isCutShort;
}
