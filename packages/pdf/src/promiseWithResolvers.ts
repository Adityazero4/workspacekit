type PromiseWithResolversShape<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function withResolvers<T>(this: PromiseConstructor): PromiseWithResolversShape<T> {
  let resolve!: PromiseWithResolversShape<T>['resolve'];
  let reject!: PromiseWithResolversShape<T>['reject'];
  const promise = new this<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const WORKER_POLYFILL =
  "typeof Promise.withResolvers === 'function' || Object.defineProperty(Promise, 'withResolvers', {" +
  ' value() { let resolve, reject; const promise = new this((settle, fail) => { resolve = settle; reject = fail; });' +
  ' return { promise, resolve, reject }; }, writable: true, configurable: true });';

const polyfilledWorkerUrls = new Map<string, string>();

/**
 * Installs `Promise.withResolvers` when the browser lacks it (before Chrome 119, Safari 17.4, Firefox 121),
 * and says whether this polyfill is the one in place. pdf.js's legacy build calls it without a polyfill,
 * though never while its modules evaluate, so `openDocument` calls this first: the app's own globals are
 * untouched until a PDF opens, and never where the method exists.
 *
 * @example
 * ```ts
 * const isPolyfilled = installPromiseWithResolvers();
 * const { promise, resolve } = Promise.withResolvers<number>();
 * ```
 */
export function installPromiseWithResolvers(): boolean {
  const statics = Promise as PromiseConstructor & { withResolvers?: unknown };
  if (typeof statics.withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', {
      value: withResolvers,
      writable: true,
      configurable: true,
    });
  }
  return statics.withResolvers === withResolvers;
}

/**
 * A `blob:` module URL that installs `Promise.withResolvers` where it is missing and then imports the module
 * at `workerUrl`, for a browser whose workers lack it too (pdf.js's worker calls it as well). pdf.js wraps a
 * cross-origin worker the same way, so a CSP needs `worker-src blob:` for it. One URL per `workerUrl`.
 *
 * @example
 * ```ts
 * GlobalWorkerOptions.workerSrc = installPromiseWithResolvers() ? polyfilledWorkerUrl(workerUrl) : workerUrl;
 * ```
 */
export function polyfilledWorkerUrl(workerUrl: string): string {
  let url = polyfilledWorkerUrls.get(workerUrl);
  if (url === undefined) {
    const source = `${WORKER_POLYFILL}\nawait import(${JSON.stringify(new URL(workerUrl, document.baseURI).href)});`;
    url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    polyfilledWorkerUrls.set(workerUrl, url);
  }
  return url;
}
