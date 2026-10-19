const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const foldGrapheme = (grapheme: string): string =>
  grapheme.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

interface FoldedText {
  folded: string;
  graphemeStarts: number[];
  foldedStarts: number[];
}

function foldByGrapheme(text: string): FoldedText {
  const graphemeStarts: number[] = [];
  const foldedStarts: number[] = [];
  let folded = '';
  for (const { segment, index } of graphemes.segment(text)) {
    graphemeStarts.push(index);
    foldedStarts.push(folded.length);
    folded += foldGrapheme(segment);
  }
  graphemeStarts.push(text.length);
  foldedStarts.push(folded.length);
  return { folded, graphemeStarts, foldedStarts };
}

function graphemeContaining(foldedStarts: readonly number[], foldedOffset: number): number {
  let grapheme = 0;
  while (foldedStarts[grapheme + 1]! <= foldedOffset) grapheme++;
  return grapheme;
}

function mergeTouching(ranges: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * Where `query` occurs in `name`, as `[start, end)` string offsets into `name` itself, ignoring case and
 * Unicode normalization (NFC). Matching folds both strings, which can change their length (`ß` matches `ss`,
 * a decomposed `é` matches a composed one), so each match is widened to whole characters of `name`. Matches
 * never overlap.
 *
 * @example
 * ```ts
 * highlightRanges('ReadMe.md', 'readme'); // [[0, 6]]
 * ```
 */
export function highlightRanges(name: string, query: string): Array<[start: number, end: number]> {
  const needle = foldByGrapheme(query).folded;
  if (needle === '') return [];
  const { folded, graphemeStarts, foldedStarts } = foldByGrapheme(name);
  const ranges: Array<[number, number]> = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const first = graphemeContaining(foldedStarts, at);
    const last = graphemeContaining(foldedStarts, at + needle.length - 1);
    ranges.push([graphemeStarts[first]!, graphemeStarts[last + 1]!]);
  }
  return mergeTouching(ranges);
}
