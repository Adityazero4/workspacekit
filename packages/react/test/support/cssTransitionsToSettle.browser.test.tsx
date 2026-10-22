import { expect, test } from 'vitest';
import { cssTransitionsToSettle } from './cssTransitionsToSettle';

const nextFrame = (): Promise<number> => new Promise(requestAnimationFrame);

function setBackgroundAndRestyle(element: HTMLElement, color: string): void {
  element.style.backgroundColor = color;
  getComputedStyle(element).getPropertyValue('background-color');
}

test('waits out a transition that is retargeted mid-flight instead of rejecting with its AbortError', async () => {
  const element = document.body.appendChild(document.createElement('div'));
  element.style.transition = 'background-color 100ms linear';
  setBackgroundAndRestyle(element, 'rgb(0, 0, 0)');
  setBackgroundAndRestyle(element, 'rgb(255, 255, 255)');
  const [running] = element.getAnimations();
  expect(running).toBeInstanceOf(CSSTransition);

  const settled = cssTransitionsToSettle();
  await nextFrame();
  setBackgroundAndRestyle(element, 'rgb(255, 0, 0)');
  expect(running!.playState, 'the first transition was cancelled and replaced').toBe('idle');

  await expect(settled).resolves.toBeUndefined();
  expect(element.getAnimations()).toEqual([]);
  expect(getComputedStyle(element).backgroundColor).toBe('rgb(255, 0, 0)');
  element.remove();
});
