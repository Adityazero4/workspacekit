import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import { Workspace } from '@scope/workspace';
import '@scope/workspace/styles.css';
import { afterEach, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { mixedFiles } from '../../react/bench/scenarios';
import {
  activeTabName,
  expectNoAxeViolationsInEitherColorScheme,
  goToRow,
  isTreeRow,
  press,
  rowNames,
  tabUntil,
  TO_THE_END_OF_THE_TEXT,
} from '../../react/test/support/keyboardOnly';
import { docxBytes, paragraph } from '../../docx/test/fixtures/docx';
import { pdfBytes } from '../../pdf/test/fixtures/pdf';
import { pptxBytes, textSlides } from '../../pptx/test/fixtures/pptx';
import { inlineCell, numberCell, sheetData, xlsxBytes } from '../../spreadsheet/test/support/xlsxFixture';

const FIRST_LOAD = { timeout: 15_000 };
const AFTER_AN_AUTOSAVE = { timeout: 4000 };
const TEST_TIMEOUT_MS = 30_000;
const CODE = 'export const answer = 42;\n';
const MARKDOWN = '# Notes\n\nStart.\n';

async function filesOfEveryKind(): Promise<Record<string, string | Uint8Array>> {
  const { files: mixed } = await mixedFiles();
  const lightKinds = Object.entries(mixed)
    .filter(([path]) => path.startsWith('0/') && !path.startsWith('0/folder/'))
    .map(([path, contents]) => [path.slice('0/'.length), contents]);
  return {
    ...Object.fromEntries(lightKinds),
    'main.ts': CODE,
    'notes.md': MARKDOWN,
    'report.pdf': pdfBytes({ pages: [{ text: 'Quarterly report' }, { text: 'Page two' }] }),
    'letter.docx': docxBytes({ body: paragraph('Dear reader') }),
    'deck.pptx': pptxBytes({ slides: textSlides(2) }),
    'table.csv': 'name,count\napples,3\npears,5\n',
    'book.xlsx': xlsxBytes({
      sheets: [{ name: 'Sheet1', body: sheetData([[inlineCell('A1', 'Total'), numberCell('B1', 8)]]) }],
    }),
  };
}

async function mountWorkspace(): Promise<MemoryAdapter> {
  const adapter = createMemoryAdapter({ files: await filesOfEveryKind() });
  await render(<Workspace adapter={adapter} style={{ width: 1100, height: 640 }} />);
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  return adapter;
}

afterEach(async () => {
  await commands.emulateMedia({ colorScheme: null });
});

const workspace = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=workspace]')!;
const inTheOpenTab = <Found extends Element = HTMLElement>(selector: string): Found | null =>
  document.querySelector<Found>(`[role=tabpanel]:not([hidden]) ${selector}`);
const saveStatusText = (): string | null | undefined =>
  inTheOpenTab('[data-fs-part=viewer-save-status]')?.textContent;
const saveBanner = (): HTMLElement | null => inTheOpenTab('[data-fs-part=save-banner]');
const isBannerButton =
  (label: string) =>
  (element: Element): boolean =>
    element.textContent === label && element.closest('[data-fs-part=save-banner]') !== null;

async function openFromTheTree(name: string): Promise<void> {
  if (!isTreeRow(document.activeElement!)) {
    const fromNowhere = document.activeElement === document.body;
    await tabUntil(isTreeRow, 'the tree', fromNowhere ? 'forwards' : 'backwards');
  }
  await goToRow(name);
  await press('{Enter}');
  await expect.poll(activeTabName).toBe(name);
}

async function typeAtTheEndOf(editor: () => HTMLElement | null, text: string): Promise<void> {
  await expect.poll(editor, FIRST_LOAD).not.toBeNull();
  if (document.activeElement !== editor()) {
    await tabUntil((element) => element === editor(), 'the editor');
  }
  await press(`${TO_THE_END_OF_THE_TEXT}${text}`);
}

test.each([
  ['main.ts', '[data-fs-part=code-editor] .cm-content'],
  ['notes.md', '[data-fs-part=md-editor] [contenteditable]'],
  ['report.pdf', '[data-fs-part=pdf-page] canvas'],
  ['letter.docx', '[data-fs-part=docx-document]'],
  ['deck.pptx', '[data-fs-part=pptx-slide]'],
  ['table.csv', '[role=gridcell]'],
  ['book.xlsx', '[role=gridcell]'],
  ['data.json', '[data-fs-part=code-editor] .cm-content'],
  ['notes.txt', '[data-fs-part=text-editor]'],
  ['page.html', '[data-fs-part=html-viewer]'],
  ['photo.png', '[data-fs-part=image-content]'],
  ['logo.svg', '[data-fs-part=image-content]'],
  ['scan.tiff', '[data-fs-part=tiff-page-image]'],
  ['sound.wav', '[data-fs-part=media-audio]'],
  ['clip.mp4', '[data-fs-part=media-viewer]'],
  ['blob.bin', '[data-fs-part=viewer-unsupported]'],
])(
  '%s opens from the tree with the keyboard, with no axe violations in light or dark',
  async (name, shown) => {
    await mountWorkspace();
    await openFromTheTree(name);
    await expect.poll(() => inTheOpenTab(shown), FIRST_LOAD).not.toBeNull();
    await expectNoAxeViolationsInEitherColorScheme(workspace(), `${name} open`);
  },
  TEST_TIMEOUT_MS,
);

test(
  'code: an edit autosaves, and an agent write over unsaved edits is resolved with Keep mine, keyboard only',
  async () => {
    const adapter = await mountWorkspace();
    await openFromTheTree('main.ts');
    const editor = (): HTMLElement | null => inTheOpenTab('[data-fs-part=code-editor] .cm-content');

    await typeAtTheEndOf(editor, '// edited');
    await expect.poll(() => adapter.read('main.ts', 'text'), AFTER_AN_AUTOSAVE).toBe(`${CODE}// edited`);
    await expect.poll(saveStatusText).toBe('Saved');

    await typeAtTheEndOf(editor, ' by me');
    await adapter.write!('main.ts', 'export const answer = 43;\n');
    await expect.poll(saveBanner).not.toBeNull();
    await expect.poll(saveStatusText).toBe('Changed by someone else');
    await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a code conflict banner');
    await tabUntil(isBannerButton('Keep mine'), 'Keep mine', 'backwards');
    await press('{Enter}');
    await expect.poll(() => adapter.read('main.ts', 'text')).toBe(`${CODE}// edited by me`);
    await expect.poll(saveStatusText).toBe('Saved');
    expect(saveBanner()).toBeNull();
  },
  TEST_TIMEOUT_MS,
);

test(
  'markdown: an edit autosaves, and an agent write over unsaved edits is resolved with Take theirs, keyboard only',
  async () => {
    const adapter = await mountWorkspace();
    await openFromTheTree('notes.md');
    const editor = (): HTMLElement | null => inTheOpenTab('[data-fs-part=md-editor] [contenteditable]');

    await typeAtTheEndOf(editor, ' Mine.');
    await expect
      .poll(() => adapter.read('notes.md', 'text'), AFTER_AN_AUTOSAVE)
      .toBe(MARKDOWN.replace('Start.', 'Start. Mine.'));
    await expect.poll(saveStatusText).toBe('Saved');

    await typeAtTheEndOf(editor, ' More.');
    await adapter.write!('notes.md', '# Notes\n\nTheirs.\n');
    await expect.poll(saveBanner).not.toBeNull();
    await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a markdown conflict banner');
    await tabUntil(isBannerButton('Take theirs'), 'Take theirs', 'backwards');
    await press('{Enter}');
    await expect.poll(() => editor()?.textContent).toBe('NotesTheirs.');
    expect(saveBanner()).toBeNull();
    expect(await adapter.read('notes.md', 'text')).toBe('# Notes\n\nTheirs.\n');
  },
  TEST_TIMEOUT_MS,
);
