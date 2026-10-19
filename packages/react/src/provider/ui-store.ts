/**
 * Small external store; snapshot is immutable; set() notifies once per change.
 *
 * @example
 * ```ts
 * const selected: UiStore<string | null> = createUiStore<string | null>(null);
 * ```
 */
export interface UiStore<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * A minimal external store for UI state, readable with `useSyncExternalStore` (or `useUiValue`).
 * Setting a value identical to the current one (`Object.is`) notifies nobody.
 *
 * @example
 * ```ts
 * const expanded = createUiStore<ReadonlySet<string>>(new Set());
 * expanded.set((prev) => new Set(prev).add('src'));
 * ```
 */
export function createUiStore<T>(initial: T): UiStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const nextValue = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      if (Object.is(nextValue, value)) return;
      value = nextValue;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * `set` with every one of `items` added (`member` true) or removed (`member` false); `set` itself when
 * nothing would change, so a `UiStore` holding it notifies nobody.
 *
 * @example
 * ```ts
 * expanded.set((previous) => withMembership(previous, ['src', 'src/app'], true));
 * ```
 */
export function withMembership<T>(set: ReadonlySet<T>, items: readonly T[], member: boolean): ReadonlySet<T> {
  if (items.every((item) => set.has(item) === member)) return set;
  const next = new Set(set);
  for (const item of items) {
    if (member) next.add(item);
    else next.delete(item);
  }
  return next;
}
