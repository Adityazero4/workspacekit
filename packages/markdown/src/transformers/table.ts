import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  type MultilineElementTransformer,
} from '@lexical/markdown';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $getState,
  $isElementNode,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {
  delimiterAlignments,
  opensTable,
  tableCells,
  tableRowContent,
  type ColumnAlignment,
} from '../markdownStructure';
import { INLINE_TRANSFORMERS } from './emphasis';

const delimiterRowState = createState('fsTableDelimiterRow', {
  parse: (value) => (typeof value === 'string' ? value : ''),
});

function $appendRow(table: TableNode, cells: string[], width: number, alignments: ColumnAlignment[]): void {
  const row = $createTableRowNode();
  const isHeader = table.getChildrenSize() === 0;
  for (let column = 0; column < width; column++) {
    const cell = $createTableCellNode(isHeader ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
    $convertFromMarkdownString(cells[column] ?? '', INLINE_TRANSFORMERS, cell);
    for (const paragraph of cell.getChildren()) {
      if ($isElementNode(paragraph)) paragraph.setFormat(alignments[column] ?? '');
    }
    row.append(cell);
  }
  table.append(row);
}

function $importTable(
  lines: string[],
  startLineIndex: number,
  container: ElementNode,
): [boolean, number] | null {
  if (!opensTable(lines, startLineIndex)) return null;
  const header = tableRowContent(lines[startLineIndex] ?? '') ?? '';
  const delimiterRow = tableRowContent(lines[startLineIndex + 1] ?? '') ?? '';
  const alignments = delimiterAlignments(delimiterRow) ?? [];
  const rows = [tableCells(header)];
  let end = startLineIndex + 2;
  let row = tableRowContent(lines[end] ?? '');
  while (row !== null) {
    rows.push(tableCells(row));
    end++;
    row = tableRowContent(lines[end] ?? '');
  }
  const width = rows.reduce((widest, cells) => Math.max(widest, cells.length), alignments.length);
  const table = $createTableNode();
  $setState(table, delimiterRowState, delimiterRow);
  for (const cells of rows) $appendRow(table, cells, width, alignments);
  container.append(table);
  return [true, end - 1];
}

const DELIMITER_BY_ALIGNMENT: Readonly<Record<string, string>> = {
  left: ':---',
  center: ':---:',
  right: '---:',
};

function $exportCell(cell: LexicalNode): string {
  if (!$isElementNode(cell)) return '';
  return $convertToMarkdownString(INLINE_TRANSFORMERS, cell).replaceAll('\n', '<br>').replaceAll('|', '\\|');
}

function $columnFormats(table: TableNode): string[] {
  const header = table.getFirstChild();
  if (!$isElementNode(header)) return [];
  return header.getChildren().map((cell) => {
    const paragraph = $isElementNode(cell) ? cell.getFirstChild() : null;
    return $isElementNode(paragraph) ? paragraph.getFormatType() : '';
  });
}

function $exportTable(node: LexicalNode): string | null {
  if (!$isTableNode(node)) return null;
  const rows = node
    .getChildren()
    .map((row) => ($isElementNode(row) ? row.getChildren().map($exportCell) : []));
  const lines = rows.map((cells) => `| ${cells.join(' | ')} |`);
  const formats = $columnFormats(node);
  const stored = $getState(node, delimiterRowState);
  const delimiterRow =
    stored !== '' && tableCells(stored).length === formats.length
      ? stored
      : `| ${formats.map((format) => DELIMITER_BY_ALIGNMENT[format] ?? '---').join(' | ')} |`;
  lines.splice(1, 0, delimiterRow);
  return lines.join('\n');
}

/**
 * GitHub tables: a header row, a delimiter row whose colons set each column's alignment, and the body rows
 * that follow, every row starting with `|`. `\|` is a pipe inside a cell (code spans included) and is
 * written back escaped. Cells hold inline Markdown. The delimiter row is kept and written back unchanged
 * while the column count is the same, so alignment and its spelling survive. A table ends at the first
 * line that is not a row, so two tables with a blank line between them stay two tables.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString('| a | b |\n|:--|--:|\n| 1 | 2 |', [GFM_TABLE]);
 * ```
 */
export const GFM_TABLE: MultilineElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  export: $exportTable,
  regExpStart: /^ {0,3}\|/,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) =>
    $importTable(lines, startLineIndex, rootNode),
  replace: () => false,
  type: 'multiline-element',
};
