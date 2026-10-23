import { expect, test } from 'vitest';
import { splitDocument } from '../src/frontmatter';
import { estimatedImportWork, fitsTheRenderedView } from '../src/renderedView';
import {
  countEngineWorkInThisFile,
  IMPORT_WORK_BUDGET,
  measuredImportWork,
  MEASURED_TO_ESTIMATED_CEILING,
} from './importWork';

countEngineWorkInThisFile();

const STRUCTURE_MISMATCHES: Record<string, (size: number) => string> = {
  'a tab-indented fence around emphasis': (size) => `\t\`\`\`\n${'*a* '.repeat(size / 4)}`,
  'a fence with a backtick info string': (size) => `\`\`\`x\`\n${'*a* '.repeat(size / 4)}`,
  'a tab-indented fence around paragraph lines': (size) => `\t\`\`\`\n${'a\n'.repeat(size / 2)}`,
  'a pipe-only delimiter row': (size) => `| a\n|\n${'| a\n'.repeat(size / 4)}`,
  'a delimiter row with spaced dashes': (size) => `| a |\n| - - |\n${'| *a* |\n'.repeat(size / 8)}`,
  'table rows indented four spaces': (size) => `| a |\n|---|\n${'    | a |\n'.repeat(size / 10)}`,
  'frontmatter that opens a fence': (size) => `---\n\`\`\`\n---\n${'*a* '.repeat(size / 4)}`,
};

const HOSTILE: Record<string, (size: number) => string> = {
  'nested >': (size) => '>'.repeat(size),
  'nested > with spaces': (size) => '> '.repeat(size / 2),
  'quote lines': (size) => '> a\n'.repeat(size / 4),
  'emphasis spans': (size) => '*a* '.repeat(size / 4),
  'unclosed brackets': (size) => '['.repeat(size),
  'link openers': (size) => '[a]('.repeat(size / 4),
  'code spans': (size) => '`a '.repeat(size / 3),
  'paragraph lines': (size) => 'a\n'.repeat(size / 2),
  'escaped pipes in a table': (size) => `| a |\n| - |\n| ${'\\|'.repeat(size / 2)} |`,
  'unclosed fences': (size) => '```\n'.repeat(size / 4),
  'table openers': (size) => '| a |\n'.repeat(size / 6),
  ...STRUCTURE_MISMATCHES,
};
const SIZES = [1_000, 4_000, 16_000, 64_000];

test.each(Object.entries(HOSTILE))(
  'hostile Markdown (%s) is bounded work: refused by the gate, or imported within a fixed multiple of the budget',
  (_, make) => {
    for (const size of SIZES) {
      const markdown = make(size);
      if (!fitsTheRenderedView(markdown)) continue;
      const { body } = splitDocument(markdown);
      expect(estimatedImportWork(body)).toBeLessThanOrEqual(IMPORT_WORK_BUDGET);
      expect(measuredImportWork(body), `${size} characters`).toBeLessThanOrEqual(
        MEASURED_TO_ESTIMATED_CEILING * IMPORT_WORK_BUDGET,
      );
    }
  },
);

test.each(Object.entries(STRUCTURE_MISMATCHES))(
  'a look-alike the transformers reject is charged like the text it is (%s): refused at 64,000 characters',
  (_, make) => {
    expect(fitsTheRenderedView(make(64_000))).toBe(false);
  },
);

test.each([
  ['8,000 spaces before a list marker', `${' '.repeat(8_000)}- a`],
  ['a tab-indented ordered list marker', `${'\t'.repeat(2_000)}1. a`],
])('a list nested past any real depth is refused (%s)', (_, markdown) => {
  expect(fitsTheRenderedView(markdown)).toBe(false);
});

test('a list nested a few levels deep still fits', () => {
  const nested = Array.from({ length: 12 }, (_, depth) => `${'  '.repeat(depth)}- item ${depth}`).join('\n');
  expect(fitsTheRenderedView(nested)).toBe(true);
});

test('100,000 nested > fit and import in linear work', () => {
  const markdown = '>'.repeat(100_000);
  expect(fitsTheRenderedView(markdown)).toBe(true);
  expect(measuredImportWork(markdown)).toBeLessThan(20 * markdown.length);
});

test('a 1 MB line never reaches the engine', () => {
  expect(fitsTheRenderedView(`${'*a* '.repeat(250_000)}`)).toBe(false);
  expect(fitsTheRenderedView('a'.repeat(1_000_000))).toBe(false);
});

test('the work counter sees the engine’s quadratic re-scans that the gate refuses', () => {
  const small = measuredImportWork('*a* '.repeat(500));
  const large = measuredImportWork('*a* '.repeat(2_000));
  expect(large / small).toBeGreaterThan(10);
  expect(fitsTheRenderedView('*a* '.repeat(50_000))).toBe(false);
});
