const runningTransitions = (): Animation[] =>
  document.getAnimations().filter((animation) => animation instanceof CSSTransition);

/**
 * Resolves once no CSS transition is running, so a check such as axe's colour contrast reads settled colours.
 * A transition whose end value changes mid-flight, as a theme switch does, is cancelled and replaced by a new
 * one, and its `finished` promise rejects with an `AbortError`. So this lets each batch settle either way and
 * looks again for the replacements, until none are left.
 */
export async function cssTransitionsToSettle(): Promise<void> {
  await new Promise(requestAnimationFrame);
  for (let running = runningTransitions(); running.length > 0; running = runningTransitions()) {
    await Promise.allSettled(running.map((transition) => transition.finished));
  }
}
