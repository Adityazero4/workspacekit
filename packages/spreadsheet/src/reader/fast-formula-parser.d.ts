declare module 'fast-formula-parser' {
  interface CellReference {
    sheet: string;
    row: number;
    col: number;
  }

  interface RangeReference {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }

  class FormulaError extends Error {
    constructor(error: string);
    readonly error: string;
  }

  export default class FormulaParser {
    constructor(config: {
      onCell?: (reference: CellReference) => unknown;
      onRange?: (reference: RangeReference) => unknown[][];
      functions?: Record<string, (...args: never[]) => unknown>;
    });
    parse(formula: string, position: CellReference): unknown;
    static FormulaError: typeof FormulaError;
    static FormulaHelpers: {
      accept: (value: unknown, type?: number) => unknown;
      flattenParams: (
        params: unknown[],
        type: number,
        allowUnion: boolean,
        hook: (item: unknown, info: { isLiteral: boolean }) => void,
      ) => void;
    };
    static Types: { STRING: number; NUMBER: number };
  }
}
