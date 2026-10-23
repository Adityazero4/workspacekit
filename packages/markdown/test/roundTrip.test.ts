import { readFileSync } from 'node:fs';
import { $createTextNode, $getRoot, $isElementNode, createEditor, type LexicalEditor } from 'lexical';
import { expect, test } from 'vitest';
import { joinDocument, splitDocument } from '../src/frontmatter';
import { $exportMarkdown, $importMarkdown, MARKDOWN_NODES } from '../src/transformers';

const fixture = (name: string): string => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

function headlessEditor(): LexicalEditor {
  return createEditor({
    namespace: 'test',
    nodes: MARKDOWN_NODES,
    onError: (error) => {
      throw error;
    },
  });
}

function roundTrip(text: string, edit?: () => void): string {
  const editor = headlessEditor();
  const parts = splitDocument(text);
  editor.update(() => $importMarkdown(parts.body), { discrete: true });
  if (edit) editor.update(edit, { discrete: true });
  return joinDocument({ ...parts, body: editor.getEditorState().read($exportMarkdown) });
}

const appendToLastParagraph = (): void => {
  const last = $getRoot().getLastChild();
  if ($isElementNode(last)) last.append($createTextNode(' Edited.'));
};

test('supported Markdown comes back byte for byte: tables with alignment and escaped pipes, frontmatter, ~~~ and ``` fences, ***, escapes', () => {
  const text = fixture('supported.md');
  expect(roundTrip(text)).toBe(text);
});

test('an edit keeps every supported construct and changes only the edited text', () => {
  const text = fixture('supported.md');
  expect(roundTrip(text, appendToLastParagraph)).toBe(
    text.replace('Last paragraph.', 'Last paragraph. Edited.'),
  );
});

test('constructs the editor cannot keep are normalised the documented way (golden file)', () => {
  expect(roundTrip(fixture('normalized.md'))).toBe(fixture('normalized.expected.md'));
});

test.each([
  ['a table next to a table', '| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |'],
  ['a longer fence around a shorter one', '~~~~\n~~~\n~~~~'],
  ['an empty fence', '```\n```'],
  ['a rule of underscores', '___'],
  ['a setext level 2 heading', 'Title\n-----'],
])('%s round-trips', (_, markdown) => {
  const expected = markdown === 'Title\n-----' ? '## Title' : markdown;
  expect(roundTrip(markdown)).toBe(expected);
});

test.each([
  ['an unclosed fence runs to the end and is closed', '```js\nlet a\n\nlet b', '```js\nlet a\n\nlet b\n```'],
  ['a short row is padded', '| a | b |\n| --- | --- |\n| 1 |', '| a | b |\n| --- | --- |\n| 1 |  |'],
  ['a delimiter row that is not one leaves text', '| a |\n| b |', '| a |\n| b |'],
  ['a lone = line stays text', 'a\n\n===', 'a\n\n==='],
])('%s', (_, markdown, expected) => {
  expect(roundTrip(markdown)).toBe(expected);
});

test('a code block whose text gains a closing fence is written with a longer fence', () => {
  const written = roundTrip('~~~\na\n~~~', () => {
    const block = $getRoot().getFirstChild();
    if ($isElementNode(block)) block.append($createTextNode('\n~~~~'));
  });
  expect(written).toBe('~~~~~\na\n~~~~\n~~~~~');
});

test('a link to javascript: is kept as text in the file but is never a live link (see the browser tests)', () => {
  expect(roundTrip('[x](javascript:alert(1))')).toBe('[x](javascript:alert\\(1\\))');
});
