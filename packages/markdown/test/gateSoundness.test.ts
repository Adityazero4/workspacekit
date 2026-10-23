import { withLfLineBreaks } from '@scope/react/renderer-kit';
import { expect, test } from 'vitest';
import { splitDocument } from '../src/frontmatter';
import { estimatedImportWork, fitsTheRenderedView } from '../src/renderedView';
import {
  countEngineWorkInThisFile,
  IMPORT_WORK_BUDGET,
  measuredImportWork,
  MEASURED_TO_ESTIMATED_CEILING,
} from './importWork';
import {
  documentStart,
  inlineRun,
  markdownMotif,
  seededRandom,
  withLineEndings,
  withoutBlankLines,
  type Random,
} from './markdownGrammar';

countEngineWorkInThisFile();

const SEEDS = Array.from({ length: 100 }, (_, index) => index + 1);
const SMALL = 4_000;
const LARGE = 16_000;
const MOTIF_LENGTH = 800;
const GROWTH_CEILING_PER_FOUR_TIMES = 6;
const GROWTH_OVER_THE_ESTIMATE = 1.5;

type Shape = 'tiled' | 'merged' | 'one line';
const SHAPES: readonly Shape[] = ['tiled', 'merged', 'one line'];

interface Sample {
  length: number;
  fits: boolean;
  measured: number;
  estimated: number;
}

function repeatedUnit(random: Random, shape: Shape): string {
  if (shape === 'one line') return inlineRun(random, MOTIF_LENGTH);
  const motif = markdownMotif(random, MOTIF_LENGTH);
  return shape === 'tiled' ? motif : withoutBlankLines(motif);
}

function documentsFor(seed: number, shape: Shape): [string, string] {
  const random = seededRandom(seed);
  const start = documentStart(random);
  const unit = repeatedUnit(random, shape);
  const sized = (length: number): string =>
    withLineEndings(seededRandom(seed), start + unit.repeat(Math.ceil(length / unit.length)));
  return [sized(SMALL), sized(LARGE)];
}

function sample(text: string): Sample {
  const fits = fitsTheRenderedView(text);
  const body = splitDocument(withLfLineBreaks(text)).body;
  const measured = fits ? measuredImportWork(body) : 0;
  return { length: text.length, fits, measured, estimated: estimatedImportWork(body) };
}

function expectWithinTheCeiling(seed: number, { length, fits, measured, estimated }: Sample): void {
  if (!fits) return;
  const context = `seed ${seed}, ${length} characters`;
  expect(measured, context).toBeLessThanOrEqual(MEASURED_TO_ESTIMATED_CEILING * Math.max(estimated, length));
  expect(measured, context).toBeLessThanOrEqual(MEASURED_TO_ESTIMATED_CEILING * IMPORT_WORK_BUDGET);
}

const accepted = { small: 0, large: 0 };

test.each(SEEDS)(
  'generated document %i: whatever the gate accepts imports within the ceiling, growing no faster than allowed',
  (seed) => {
    const shape = SHAPES[seed % SHAPES.length]!;
    const [small, large] = documentsFor(seed, shape).map(sample) as [Sample, Sample];
    expectWithinTheCeiling(seed, small);
    expectWithinTheCeiling(seed, large);
    accepted.small += small.fits ? 1 : 0;
    accepted.large += large.fits ? 1 : 0;
    if (!small.fits || !large.fits) return;
    const lengthGrowth = large.length / small.length;
    const workGrowth = large.measured / Math.max(small.measured, 1);
    const estimateGrowth = large.estimated / Math.max(small.estimated, 1);
    const linear = (GROWTH_CEILING_PER_FOUR_TIMES * lengthGrowth) / 4;
    const allowed = shape === 'tiled' ? linear : Math.max(linear, GROWTH_OVER_THE_ESTIMATE * estimateGrowth);
    expect(workGrowth, `seed ${seed} (${shape})`).toBeLessThanOrEqual(allowed);
  },
);

test('the generated documents exercise the import, not only the gate', () => {
  expect(accepted.small).toBeGreaterThanOrEqual(SEEDS.length * 0.6);
  expect(accepted.large).toBeGreaterThanOrEqual(SEEDS.length * 0.4);
});
