import { afterEach, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { partProps } from '../src/cx';
import '../src/styles.css';

const LIGHT_FG = 'rgb(31, 35, 40)';
const DARK_FG = 'rgb(230, 237, 243)';

afterEach(async () => {
  document.head.querySelectorAll('style[data-test]').forEach((s) => s.remove());
  await commands.emulateMedia({ colorScheme: null, reducedMotion: null });
});

const row = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=tree-row]')!;

const rowColor = async (theme?: 'light' | 'dark'): Promise<string> => {
  const { unmount } = await render(
    <div data-theme={theme}>
      <div {...partProps('tree-row')}>a</div>
    </div>,
  );
  const color = getComputedStyle(row()).color;
  await unmount();
  return color;
};

// Emulation reaches the test iframe asynchronously (Firefox), so poll for the precondition.
const scheme = (dark: boolean): Promise<void> =>
  expect.poll(() => window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(dark);

const reducedMotion = (): Promise<void> =>
  expect.poll(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);

const addStyle = (css: string, where: 'before' | 'after'): void => {
  const style = document.createElement('style');
  style.dataset.test = '';
  style.textContent = css;
  if (where === 'before') document.head.prepend(style);
  else document.head.append(style);
};

test('data-theme applies tokens in light and dark', async () => {
  expect(await rowColor('light')).toBe(LIGHT_FG);
  expect(await rowColor('dark')).toBe(DARK_FG);
});

test('prefers-color-scheme: dark with no data-theme uses the dark tokens', async () => {
  await commands.emulateMedia({ colorScheme: 'dark' });
  await scheme(true);
  expect(await rowColor()).toBe(DARK_FG);
});

test('prefers-color-scheme: light with no data-theme uses the light tokens', async () => {
  await commands.emulateMedia({ colorScheme: 'light' });
  await scheme(false);
  expect(await rowColor()).toBe(LIGHT_FG);
});

test('data-theme="light" overrides an OS dark preference', async () => {
  await commands.emulateMedia({ colorScheme: 'dark' });
  await scheme(true);
  expect(await rowColor('light')).toBe(LIGHT_FG);
});

test('data-theme="dark" overrides an OS light preference', async () => {
  await commands.emulateMedia({ colorScheme: 'light' });
  await scheme(false);
  expect(await rowColor('dark')).toBe(DARK_FG);
});

test('unlayered consumer CSS beats the default theme even when it comes first', async () => {
  // Prepended: it precedes the library stylesheet, so only `@layer fs` lets it win.
  addStyle('[data-fs-part="tree-row"]{color: rgb(1, 2, 3)}', 'before');
  await render(<div {...partProps('tree-row')}>a</div>);
  expect(getComputedStyle(row()).color).toBe('rgb(1, 2, 3)');
});

test('negative control: an unlayered rule later in the document beats an earlier consumer rule', async () => {
  // Proves the test above is sensitive: without a layer, source order decides and the consumer loses.
  addStyle('[data-fs-part="tree-row"]{color: rgb(1, 2, 3)}', 'before');
  addStyle('[data-fs-part="tree-row"]{color: rgb(9, 9, 9)}', 'after');
  await render(<div {...partProps('tree-row')}>a</div>);
  expect(getComputedStyle(row()).color).toBe('rgb(9, 9, 9)');
});

test('prefers-reduced-motion disables default transitions', async () => {
  await render(<div {...partProps('tree-row')}>a</div>);
  expect(getComputedStyle(row()).transitionDuration).not.toBe('0s');
  await commands.emulateMedia({ reducedMotion: 'reduce' });
  await reducedMotion();
  expect(getComputedStyle(row()).transitionDuration).toBe('0s');
});

test('a consumer !important reduced-motion override is not defeated by the library', async () => {
  await commands.emulateMedia({ reducedMotion: 'reduce' });
  await reducedMotion();
  addStyle('[data-fs-part="tree-row"]{transition: opacity 1s !important}', 'before');
  await render(<div {...partProps('tree-row')}>a</div>);
  expect(getComputedStyle(row()).transitionDuration).toBe('1s');
});

test('partProps merges classNames', () => {
  expect(partProps('tab', { tab: 'x' }, 'y').className).toBe('x y');
  expect(partProps('tab')).toEqual({ 'data-fs-part': 'tab' });
});

const channel = (value: number): number => {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};
const luminance = (color: string): number => {
  const [red, green, blue] = color.match(/\d+(\.\d+)?/g)!.map(Number);
  return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!);
};
const contrast = (first: string, second: string): number => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
};

test('form control borders reach 3:1 against their background in light and dark', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const { unmount } = await render(
      <div data-theme={theme}>
        <input aria-label="search" {...partProps('search-input')} />
        <input aria-label="name" {...partProps('dialog-input')} />
      </div>,
    );
    for (const input of document.querySelectorAll('input')) {
      const style = getComputedStyle(input);
      expect(
        contrast(style.borderTopColor, style.backgroundColor),
        `${theme} ${input.dataset.fsPart}`,
      ).toBeGreaterThanOrEqual(3);
    }
    await unmount();
  }
});

const SYNTAX_TOKENS = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'type',
  'variable',
  'operator',
  'tag',
  'attribute',
].map((name) => `--fs-syntax-${name}`);

const BACKGROUNDS_BEHIND_CODE = ['--fs-bg', '--fs-bg-selected', '--fs-flash'];

function expectSyntaxTokensReadableIn(themed: Element, label: string): void {
  for (const background of BACKGROUNDS_BEHIND_CODE) {
    const backgroundColor = getComputedStyle(themed).getPropertyValue(background);
    for (const token of SYNTAX_TOKENS) {
      const probe = document.createElement('span');
      probe.style.color = `var(${token}, transparent)`;
      probe.style.backgroundColor = backgroundColor;
      themed.append(probe);
      const style = getComputedStyle(probe);
      expect(style.color, `${label} ${token} is defined`).not.toBe('rgba(0, 0, 0, 0)');
      expect(
        contrast(style.color, style.backgroundColor),
        `${label} ${token} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
      probe.remove();
    }
  }
}

test('every --fs-syntax-* token reaches 4.5:1 on --fs-bg, --fs-bg-selected and --fs-flash, in every theme', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const { unmount } = await render(<div data-theme={theme} />);
    expectSyntaxTokensReadableIn(document.querySelector(`[data-theme=${theme}]`)!, `data-theme=${theme}`);
    await unmount();
  }
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await commands.emulateMedia({ colorScheme });
      const { unmount } = await render(<div data-testid="no-theme-attribute" />);
      expectSyntaxTokensReadableIn(
        document.querySelector('[data-testid=no-theme-attribute]')!,
        `prefers-color-scheme: ${colorScheme}`,
      );
      await unmount();
    }
  } finally {
    await commands.emulateMedia({ colorScheme: null });
  }
});

test('a flashing row pulses with --fs-flash, distinct from focus and selection, and holds it without motion', async () => {
  await render(
    <div data-fs-part="tree-row" data-selected="" data-focused="" data-flash="">
      a
    </div>,
  );
  const flashColor = (): string => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--fs-flash)';
    row().append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  expect(getComputedStyle(row()).animationName).toBe('fs-flash');
  await commands.emulateMedia({ reducedMotion: 'reduce' });
  await reducedMotion();
  expect(getComputedStyle(row()).animationName).toBe('none');
  expect(getComputedStyle(row()).backgroundColor).toBe(flashColor());
  expect(flashColor()).not.toBe('rgba(0, 0, 0, 0)');
});
