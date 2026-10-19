/**
 * What is persisted under `${storageKey}:<key>`; `hidden` is the showHidden flag.
 *
 * @example
 * ```ts
 * const key: PersistKey = 'expanded';
 * ```
 */
export type PersistKey = 'expanded' | 'sort' | 'hidden' | 'pane' | 'tabs';

const DEBOUNCE_MS = 300;

/**
 * Reads one persisted value as parsed JSON. Returns `undefined` when there is no key, no value, or storage is
 * unavailable (private mode, blocked cookies, SSR). Never throws; callers validate the shape.
 *
 * @example
 * ```ts
 * const width = readPersisted('my-app', 'pane'); // unknown
 * ```
 */
export function readPersisted(storageKey: string | undefined, key: PersistKey): unknown {
  if (!storageKey) return undefined;
  try {
    const raw = localStorage.getItem(`${storageKey}:${key}`);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Debounced writer for persisted UI state: writes land 300 ms after the last change, or at once on `pagehide`
 * or `dispose()`. Storage failures are ignored.
 *
 * @example
 * ```ts
 * const p = createPersister('my-app');
 * p.write('pane', 320);
 * p.dispose(); // flushes and stops listening for pagehide
 * ```
 */
export function createPersister(storageKey: string): {
  write(key: PersistKey, value: unknown): void;
  dispose(): void;
} {
  const queued = new Map<PersistKey, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    for (const [key, value] of queued) {
      try {
        localStorage.setItem(`${storageKey}:${key}`, JSON.stringify(value));
      } catch {
        continue;
      }
    }
    queued.clear();
  };
  window.addEventListener('pagehide', flush);
  return {
    write(key, value) {
      queued.set(key, value);
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    },
    dispose() {
      window.removeEventListener('pagehide', flush);
      flush();
    },
  };
}
