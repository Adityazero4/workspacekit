interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

function parseShortcut(shortcut: string, isMacPlatform: boolean): ParsedShortcut {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const mod = modifiers.has('mod');
  return {
    key,
    ctrl: modifiers.has('ctrl') || (mod && !isMacPlatform),
    meta: modifiers.has('meta') || modifiers.has('cmd') || (mod && isMacPlatform),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt'),
  };
}

/**
 * Whether a key press matches a shortcut such as `'Mod+Shift+K'`. `Mod` is Cmd on Apple platforms and Ctrl
 * elsewhere; letters compare case-insensitively and every modifier must match exactly.
 *
 * @example
 * ```ts
 * if (matchesShortcut('Mod+C', event, isMac())) copy();
 * ```
 */
export function matchesShortcut(shortcut: string, press: KeyPress, isMacPlatform: boolean): boolean {
  const wanted = parseShortcut(shortcut, isMacPlatform);
  return (
    press.key.toLowerCase() === wanted.key.toLowerCase() &&
    press.ctrlKey === wanted.ctrl &&
    press.metaKey === wanted.meta &&
    press.shiftKey === wanted.shift &&
    press.altKey === wanted.alt
  );
}

const displayKey = (key: string): string => (key.length === 1 ? key.toUpperCase() : key);

/**
 * A shortcut as people read it: `⌘⇧K` on Apple platforms, `Ctrl+Shift+K` elsewhere.
 *
 * @example
 * ```ts
 * shortcutLabel('Mod+C', false); // 'Ctrl+C'
 * ```
 */
export function shortcutLabel(shortcut: string, isMacPlatform: boolean): string {
  const { key, ctrl, meta, shift, alt } = parseShortcut(shortcut, isMacPlatform);
  if (isMacPlatform) {
    return `${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${meta ? '⌘' : ''}${displayKey(key)}`;
  }
  const names = [ctrl && 'Ctrl', meta && 'Meta', alt && 'Alt', shift && 'Shift', displayKey(key)];
  return names.filter(Boolean).join('+');
}

/**
 * A shortcut in the `aria-keyshortcuts` format, such as `Control+Shift+K`.
 *
 * @example
 * ```ts
 * ariaKeyShortcuts('Mod+C', true); // 'Meta+C'
 * ```
 */
export function ariaKeyShortcuts(shortcut: string, isMacPlatform: boolean): string {
  const { key, ctrl, meta, shift, alt } = parseShortcut(shortcut, isMacPlatform);
  const names = [ctrl && 'Control', meta && 'Meta', alt && 'Alt', shift && 'Shift', displayKey(key)];
  return names.filter(Boolean).join('+');
}
