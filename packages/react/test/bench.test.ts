import { expect, test } from 'vitest';
import { collectGarbage } from '../bench/scenarios';

test('the perf scenarios fail loudly when gc() is not exposed, rather than measure an uncollected heap', () => {
  expect(collectGarbage).toThrow(/--js-flags=--expose-gc/);
});
