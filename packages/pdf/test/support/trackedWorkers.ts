interface WorkerTraffic {
  live: Set<Worker>;
  started: number;
  urls: string[];
  getPageRequests: number;
}

/**
 * Every `Worker` started after `trackWorkers()` ran, while it is not terminated, and how many `GetPage`
 * requests (one worker round trip each) pdf.js has sent. pdf.js looks `Worker` up when it starts one, so
 * replacing the global is enough.
 *
 * @example
 * ```ts
 * trackWorkers();
 * await expect.poll(() => workerTraffic.live.size).toBe(0);
 * ```
 */
export const workerTraffic: WorkerTraffic = { live: new Set(), started: 0, urls: [], getPageRequests: 0 };

const isGetPageRequest = (message: unknown): boolean =>
  typeof message === 'object' && message !== null && (message as { action?: unknown }).action === 'GetPage';

/**
 * Replaces `globalThis.Worker` with a subclass that records itself in `workerTraffic`.
 *
 * @example
 * ```ts
 * trackWorkers();
 * ```
 */
export function trackWorkers(): void {
  const NativeWorker = globalThis.Worker;
  class TrackedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workerTraffic.live.add(this);
      workerTraffic.started++;
      workerTraffic.urls.push(String(url));
    }

    override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]): void {
      if (isGetPageRequest(message)) workerTraffic.getPageRequests++;
      super.postMessage(message, options as StructuredSerializeOptions);
    }

    override terminate(): void {
      workerTraffic.live.delete(this);
      super.terminate();
    }
  }
  globalThis.Worker = TrackedWorker;
}
