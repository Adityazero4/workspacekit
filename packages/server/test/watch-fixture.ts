import type { ChangeEvent } from '@workspacekit/core';

const dec = new TextDecoder();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Time for the OS watcher to be armed before the test touches the disk. */
export const armed = (): Promise<void> => sleep(250);

export const watchReq = (signal?: AbortSignal): Request =>
  new Request('http://t/api/files/watch', {
    headers: { Accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });

/** Reads an SSE body and hands out parsed pieces: data frames and comment lines. */
export function sse(res: Response): {
  frame(ms?: number): Promise<ChangeEvent[]>;
  raw(ms?: number): Promise<string>;
  until(n: number, ms?: number): Promise<ChangeEvent[][]>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
} {
  const reader = res.body!.getReader();
  let buf = '';
  let ended = false;
  const more = async (ms: number): Promise<void> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error('sse timeout')), ms)));
    const r = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(t));
    if (r.done) ended = true;
    else buf += dec.decode(r.value, { stream: true });
  };
  const rawChunk = async (ms = 3000): Promise<string> => {
    while (!buf.includes('\n\n')) {
      if (ended) throw new Error('stream ended');
      await more(ms);
    }
    const i = buf.indexOf('\n\n') + 2;
    const out = buf.slice(0, i);
    buf = buf.slice(i);
    return out;
  };
  const frame = async (ms = 3000): Promise<ChangeEvent[]> => {
    for (;;) {
      const c = await rawChunk(ms);
      if (c.startsWith('data: ')) return JSON.parse(c.slice(6, -2)) as ChangeEvent[];
    }
  };
  return {
    reader,
    raw: rawChunk,
    frame,
    async until(n, ms = 5000) {
      const frames: ChangeEvent[][] = [];
      let total = 0;
      while (total < n) {
        const f = await frame(ms);
        frames.push(f);
        total += f.length;
      }
      return frames;
    },
  };
}
