import { vi } from 'vitest';

export function shown<E extends Element = HTMLElement>(selector: string): Promise<E> {
  return vi.waitFor(() => {
    const element = document.querySelector<E>(selector);
    if (element === null) throw new Error(`${selector} is not shown`);
    return element;
  });
}
