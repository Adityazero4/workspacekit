import { afterAll } from 'vitest';

afterAll(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});
