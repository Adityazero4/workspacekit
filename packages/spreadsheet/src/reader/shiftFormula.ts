const MOST_COLUMN_LETTERS = 3;
const MOST_ROW_DIGITS = 7;
const LETTERS = 26;
const CODE_OF_A = 65;

const isLetter = (character: string | undefined): boolean =>
  character !== undefined &&
  ((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z'));
const isDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= '0' && character <= '9';
const isNamePart = (character: string | undefined): boolean =>
  isLetter(character) || isDigit(character) || character === '_' || character === '.' || character === '(';

interface Reference {
  end: number;
  isColAbsolute: boolean;
  col: number;
  isRowAbsolute: boolean;
  row: number;
}

function readRun(
  formula: string,
  start: number,
  accepts: (character: string | undefined) => boolean,
  longest: number,
): number {
  let end = start;
  while (end - start < longest + 1 && accepts(formula[end])) end++;
  return end;
}

function readReference(formula: string, start: number): Reference | undefined {
  if (start > 0 && isNamePart(formula[start - 1]) && formula[start - 1] !== '(') return undefined;
  let index = start;
  const isColAbsolute = formula[index] === '$';
  if (isColAbsolute) index++;
  const lettersEnd = readRun(formula, index, isLetter, MOST_COLUMN_LETTERS);
  if (lettersEnd === index || lettersEnd - index > MOST_COLUMN_LETTERS) return undefined;
  let col = 0;
  for (const letter of formula.slice(index, lettersEnd).toUpperCase()) {
    col = col * LETTERS + letter.charCodeAt(0) - CODE_OF_A + 1;
  }
  index = lettersEnd;
  const isRowAbsolute = formula[index] === '$';
  if (isRowAbsolute) index++;
  const digitsEnd = readRun(formula, index, isDigit, MOST_ROW_DIGITS);
  if (digitsEnd === index || digitsEnd - index > MOST_ROW_DIGITS || isNamePart(formula[digitsEnd])) {
    return undefined;
  }
  return { end: digitsEnd, isColAbsolute, col, isRowAbsolute, row: Number(formula.slice(index, digitsEnd)) };
}

function columnLetters(col: number): string {
  let letters = '';
  for (let remaining = col; remaining > 0; remaining = Math.floor((remaining - 1) / LETTERS)) {
    letters = String.fromCharCode(CODE_OF_A + ((remaining - 1) % LETTERS)) + letters;
  }
  return letters;
}

function closingQuote(formula: string, start: number): number {
  const quote = formula[start];
  let index = start + 1;
  while (index < formula.length) {
    if (formula[index] === quote && formula[index + 1] === quote) index += 2;
    else if (formula[index] === quote) return index + 1;
    else index++;
  }
  return index;
}

/**
 * Moves the relative references of a shared formula from its anchor cell to another cell, in one linear
 * pass: `A2*2` written for B2 reads `A3*2` in B3. Absolute parts (`$A$2`) stay; text in quotes is copied
 * unchanged. A reference moved off the sheet becomes `#REF!`.
 *
 * @example
 * ```ts
 * shiftFormula('SUM(A2:$B$2)', 1, 0); // 'SUM(A3:$B$2)'
 * ```
 */
export function shiftFormula(formula: string, rowOffset: number, colOffset: number): string {
  const parts: string[] = [];
  let index = 0;
  while (index < formula.length) {
    const character = formula[index];
    if (character === '"' || character === "'") {
      const end = closingQuote(formula, index);
      parts.push(formula.slice(index, end));
      index = end;
      continue;
    }
    const reference = character === '$' || isLetter(character) ? readReference(formula, index) : undefined;
    if (!reference) {
      parts.push(character!);
      index++;
      continue;
    }
    const col = reference.isColAbsolute ? reference.col : reference.col + colOffset;
    const row = reference.isRowAbsolute ? reference.row : reference.row + rowOffset;
    const isOnTheSheet = col >= 1 && row >= 1;
    parts.push(
      isOnTheSheet
        ? `${reference.isColAbsolute ? '$' : ''}${columnLetters(col)}${reference.isRowAbsolute ? '$' : ''}${row}`
        : '#REF!',
    );
    index = reference.end;
  }
  return parts.join('');
}
