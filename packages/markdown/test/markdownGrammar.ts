export type Random = () => number;

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(random: Random, choices: readonly T[]): T => choices[Math.floor(random() * choices.length)]!;
const count = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));
const times = (random: Random, low: number, high: number, make: () => string): string[] =>
  Array.from({ length: count(random, low, high) }, make);

const WORDS = ['alpha', 'beta', 'snake_case', 'a*b', 'x_y_z', '1.5', 'C#', 'a|b', '(paren)', 'end.'];

function inlineSpan(random: Random, depth: number): string {
  const word = pick(random, WORDS);
  const inner = (): string => (depth > 2 ? word : inlineSpan(random, depth + 1));
  const spans: (() => string)[] = [
    () => word,
    () => `*${inner()}*`,
    () => `**${inner()}**`,
    () => `***${inner()}***`,
    () => `_${inner()}_`,
    () => `__${inner()}__`,
    () => `~~${inner()}~~`,
    () => `\`${word}\``,
    () => `\`\` a\`b \`\``,
    () => `[${inner()}](https://example.com/${word})`,
    () => `![${word}](https://example.com/i.png "t")`,
    () => `[${word}]`,
    () => `[unclosed ${word}`,
    () => `*unclosed ${word}`,
    () => `\\*escaped\\*`,
    () => `<span>${word}</span>`,
    () => `**[*${word}*](https://example.com)**`,
  ];
  return pick(random, spans)();
}

const inlineLine = (random: Random): string => times(random, 1, 8, () => inlineSpan(random, 0)).join(' ');
const indent = (random: Random): string => pick(random, ['', ' ', '  ', '   ', '    ', '\t', ' \t', '\t  ']);

function paragraph(random: Random): string[] {
  return times(random, 1, 5, () => inlineLine(random));
}

function blockquote(random: Random): string[] {
  return times(
    random,
    1,
    6,
    () => `${pick(random, ['>', '> ', '> > ', '>>', '> > > '])}${inlineLine(random)}`,
  );
}

function list(random: Random): string[] {
  const marker = pick(random, ['- ', '* ', '+ ', '1. ', '10. ', '- [ ] ', '- [x] ', '[ ] ']);
  return times(
    random,
    1,
    6,
    () => `${pick(random, ['', '  ', '    ', '\t', '  \t'])}${marker}${inlineLine(random)}`,
  );
}

function heading(random: Random): string[] {
  const atxMarker = `${'#'.repeat(count(random, 1, 7))}${pick(random, [' ', '\t', ''])}`;
  const underline = pick(random, ['===', '---', '= = =', '-']);
  return random() < 0.5 ? [`${atxMarker}${inlineLine(random)}`] : [inlineLine(random), underline];
}

function rule(random: Random): string[] {
  return [`${indent(random)}${pick(random, ['***', '---', '___', '* * *', '- - -', '_ _ _', '**', '--'])}`];
}

function fence(random: Random): string[] {
  const marker = pick(random, ['`', '~']).repeat(count(random, 3, 5));
  const info = pick(random, ['', 'ts', 'js title="x.js"', 'x`y', ' sh ']);
  const body = times(random, 0, 6, () => `${indent(random)}${inlineLine(random)}`);
  const close = random() < 0.85 ? [`${indent(random)}${marker}`] : [];
  return [`${indent(random)}${marker}${info}`, ...body, ...close];
}

function table(random: Random): string[] {
  const columns = count(random, 1, 4);
  const row = (): string => `| ${times(random, columns, columns, () => inlineSpan(random, 1)).join(' | ')} |`;
  const delimiter = pick(random, [
    `|${'---|'.repeat(columns)}`,
    `|${':--|'.repeat(columns)}`,
    `| ${':-:'.repeat(1)} |`,
    '|',
    '| - - |',
    '|::|',
    `|${'--:|'.repeat(columns)}`,
  ]);
  return [row(), delimiter, ...times(random, 0, 6, () => `${pick(random, ['', ' ', '    ', '\t'])}${row()}`)];
}

function miscellaneous(random: Random): string[] {
  return [
    pick(random, [
      '<div align="center">',
      '</div>',
      '<!-- comment -->',
      '[ref]: https://example.com/ref "Title"',
      '[^note]: a footnote',
      '\\# not a heading',
      '1\\. not a list',
      '\\> not a quote',
      '\\- not a bullet',
      '\\---',
    ]),
  ];
}

const BLOCKS = [paragraph, blockquote, list, heading, rule, fence, table, miscellaneous];

/**
 * A self-contained stretch of Markdown (about `length` characters) from the grammar, ending with a blank
 * line so copies of it never merge into one block.
 */
export function markdownMotif(random: Random, length: number): string {
  const lines: string[] = [];
  let size = 0;
  while (size < length) {
    const block = pick(random, BLOCKS)(random);
    if (random() < 0.7) block.push('');
    lines.push(...block);
    size += block.reduce((total, line) => total + line.length + 1, 0);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * The motif with its blank lines removed, so blocks run into each other and, repeated, grow into one long
 * merged block (the shape that makes Lexical's import quadratic).
 */
export function withoutBlankLines(motif: string): string {
  return `${motif
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')}\n`;
}

/** Inline spans only, on a single line, to be repeated into one long line. */
export function inlineRun(random: Random, length: number): string {
  let run = '';
  while (run.length < length) run += `${inlineSpan(random, 0)} `;
  return run;
}

export function documentStart(random: Random): string {
  return pick(random, [
    '',
    '',
    '---\ntitle: a\n---\n\n',
    '---\nunterminated: true\n',
    '﻿---\nbom: true\n---\n',
  ]);
}

export function withLineEndings(random: Random, text: string): string {
  const ending = pick(random, ['\n', '\n', '\r\n', '\r']);
  return ending === '\n' ? text : text.replaceAll('\n', ending);
}
