/**
 * Resolves after `count` animation frames. Use it where a browser finishes work on a later frame (Firefox
 * scrolls a textarea's selection into view one frame after the value or selection changes), not as a timer.
 */
export async function animationFrames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame);
}
