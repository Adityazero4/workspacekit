import axe from 'axe-core';
import { expect } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { isMac } from '../../src/tree/keyboard';
import { cssTransitionsToSettle } from './cssTransitionsToSettle';

/** The colour schemes every accessibility check runs in. */
export const THEMES = ['light', 'dark'] as const;

/** The key chord that moves the caret to the end of a text field or editor. */
export const TO_THE_END_OF_THE_TEXT: string = isMac()
  ? '{Meta>}{ArrowDown}{/Meta}'
  : '{Control>}{End}{/Control}';

const IS_WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Firefox/.test(navigator.userAgent);

/** The tree's rows on screen, top to bottom. */
export const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];

/** The name a tree row shows. */
export const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;

/** The names of the tree's rows on screen, top to bottom. */
export const rowNames = (): Array<string | null | undefined> => rows().map(labelOf);

/** The tree row showing `name`, if it is on screen. */
export const rowNamed = (name: string): HTMLElement | undefined =>
  rows().find((row) => labelOf(row) === name);

/** The name of the focused tree row, or `undefined` when focus is not on a row. */
export const focusedRowName = (): string | null | undefined =>
  document.activeElement?.getAttribute('role') === 'treeitem' ? labelOf(document.activeElement) : undefined;

/** The selected tab. */
export const activeTab = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.getAttribute('aria-selected') === 'true',
  );

/** The name the selected tab shows. */
export const activeTabName = (): string | null | undefined =>
  activeTab()?.querySelector('[data-fs-part=tab-label]')?.textContent;

/** Types `keys` (in `userEvent.keyboard` syntax) into whatever has focus. */
export const press = (keys: string): Promise<void> => userEvent.keyboard(keys);

function tabKeys(direction: 'forwards' | 'backwards'): string {
  const modifiers = [...(IS_WEBKIT ? ['Alt'] : []), ...(direction === 'backwards' ? ['Shift'] : [])];
  return `${modifiers.map((key) => `{${key}>}`).join('')}{Tab}${modifiers
    .map((key) => `{/${key}}`)
    .reverse()
    .join('')}`;
}

/** Presses Tab (Option-Tab in WebKit, which skips links and buttons on plain Tab) until `reached` holds. */
export async function tabUntil(
  reached: (element: Element) => boolean,
  what: string,
  direction: 'forwards' | 'backwards' = 'forwards',
): Promise<void> {
  for (let presses = 0; presses < 40; presses++) {
    if (document.activeElement && reached(document.activeElement)) return;
    await press(tabKeys(direction));
  }
  throw new Error(
    `Tab never reached ${what}; focus is on ${document.activeElement?.outerHTML.slice(0, 120)}`,
  );
}

/** Whether `element` is a tree row. */
export const isTreeRow = (element: Element): boolean => element.getAttribute('role') === 'treeitem';

/** Tabs into the tree if focus is elsewhere, then arrows down from the first row to the row named `name`. */
export async function goToRow(name: string): Promise<void> {
  if (!isTreeRow(document.activeElement!)) await tabUntil(isTreeRow, 'the tree');
  await press('{Home}');
  for (let presses = 0; presses < 40 && focusedRowName() !== name; presses++) await press('{ArrowDown}');
  expect(focusedRowName(), `arrowing down to "${name}"`).toBe(name);
}

/** Expands the focused folder row with ArrowRight. */
export async function expandFocusedRow(): Promise<void> {
  const row = document.activeElement!;
  await press('{ArrowRight}');
  await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
}

/** Runs axe on `element` and records each violation, labelled with `state`, as a soft failure. */
export async function expectNoAxeViolations(element: HTMLElement, state: string): Promise<void> {
  const results = await axe.run(element);
  const described = results.violations.map(
    (violation) =>
      `${state}: ${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target).join(', ')})`,
  );
  expect.soft(described).toEqual([]);
}

/** `expectNoAxeViolations` in the light and then the dark colour scheme, once transitions have settled. */
export async function expectNoAxeViolationsInEitherColorScheme(
  element: HTMLElement,
  state: string,
): Promise<void> {
  for (const colorScheme of THEMES) {
    await commands.emulateMedia({ colorScheme });
    await expect.poll(() => matchMedia('(prefers-color-scheme: dark)').matches).toBe(colorScheme === 'dark');
    await cssTransitionsToSettle();
    await expectNoAxeViolations(element, `${colorScheme} ${state}`);
  }
  await commands.emulateMedia({ colorScheme: null });
}
