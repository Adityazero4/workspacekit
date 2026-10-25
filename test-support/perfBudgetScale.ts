/**
 * Perf budgets are wall-clock times set on one developer machine. Shared CI runners are slower, and how much
 * slower changes from run to run: the same commit has rendered the 1M-row tree in 586 ms on one runner and
 * 1,009 ms on another. A fixed multiplier either flakes on slow runners or hides regressions on fast ones.
 *
 * So each perf file first times a fixed reference workload in its own environment (plain JavaScript in Node;
 * JavaScript and DOM layout in a browser) and scales its budgets by how much slower that ran than on the
 * machine the budgets were set on.
 */

const REFERENCE_ROWS = 100_000;
const LAID_OUT_ROWS = 2_000;
const WARM_UP_RUNS = 1;
const MEASURED_RUNS = 5;
const NODE_BASELINE_MS = 36;
const BROWSER_BASELINE_MS = 30;
const SLOWEST_RUNNER_ALLOWED = 3;

function sortRows(): void {
  const rows = Array.from({ length: REFERENCE_ROWS }, (_, index) => ({
    index,
    name: `row-${(index * 7919) % REFERENCE_ROWS}`,
  }));
  rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function layOutRows(): void {
  const host = document.createElement('div');
  for (let index = 0; index < LAID_OUT_ROWS; index += 1) {
    const row = document.createElement('div');
    row.textContent = `row ${index}`;
    host.append(row);
  }
  document.body.append(host);
  void host.offsetHeight;
  host.remove();
}

function referenceRun(): void {
  sortRows();
  if (typeof document !== 'undefined') layOutRows();
}

/**
 * The median time of the reference workload in this environment, after a warm-up run.
 *
 * @example
 * const ms = referenceWorkloadMs();
 */
export function referenceWorkloadMs(): number {
  const samples: number[] = [];
  for (let run = 0; run < WARM_UP_RUNS + MEASURED_RUNS; run += 1) {
    const started = performance.now();
    referenceRun();
    if (run >= WARM_UP_RUNS) samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(MEASURED_RUNS / 2)]!;
}

/**
 * How much to multiply this environment's perf budgets by: how much slower the reference workload ran here
 * than on the machine the budgets were set on (never below 1, never above 3, so a very slow runner still
 * fails), times `margin` for jitter within one run. It prints the factor, so a perf log shows what it used.
 *
 * @example
 * const SCALE = perfBudgetScale(Number(process.env.PERF_BUDGET_SCALE ?? 1));
 */
export function perfBudgetScale(margin: number): number {
  const baselineMs = typeof document === 'undefined' ? NODE_BASELINE_MS : BROWSER_BASELINE_MS;
  const measuredMs = referenceWorkloadMs();
  const runnerFactor = Math.min(Math.max(measuredMs / baselineMs, 1), SLOWEST_RUNNER_ALLOWED);
  // eslint-disable-next-line no-console -- the perf project prints every factor it applies (Ruling P3-20)
  console.info(
    `[perf] runner factor ${runnerFactor.toFixed(2)} (reference ${measuredMs.toFixed(1)} ms, baseline ${baselineMs} ms) × margin ${margin}`,
  );
  return runnerFactor * margin;
}
