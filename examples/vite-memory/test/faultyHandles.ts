export interface Faults {
  writesAllowed: number;
  rejectNamesWith?: string;
  caseInsensitive?: boolean;
  keepMove?: boolean;
}

const originals = new WeakMap<object, object>();
const unwrapped = <Value>(value: Value): Value =>
  (typeof value === 'object' && value !== null ? (originals.get(value) ?? value) : value) as Value;

function writableThatFails(faults: Faults, real: FileSystemWritableFileStream): FileSystemWritableFileStream {
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'write') {
        return async (...args: unknown[]) => {
          if (faults.writesAllowed-- <= 0) throw new DOMException('disk full', 'QuotaExceededError');
          return (value as (...parameters: unknown[]) => Promise<void>).apply(target, args);
        };
      }
      return (value as (...parameters: unknown[]) => unknown).bind(target);
    },
  });
}

async function* wrappedEntries(
  directory: FileSystemDirectoryHandle,
  faults: Faults,
): AsyncGenerator<[string, FileSystemHandle]> {
  for await (const [name, child] of directory.entries()) yield [name, faulty(child, faults)];
}

async function nameAsStored(
  directory: FileSystemDirectoryHandle,
  name: string,
  faults: Faults,
): Promise<string> {
  if (!faults.caseInsensitive) return name;
  for await (const [stored] of directory.entries()) {
    if (stored.toLowerCase() === name.toLowerCase()) return stored;
  }
  return name;
}

/**
 * Wraps a handle so that `move()` is absent, so the adapter takes its copying path, and so that writes
 * fail once `faults.writesAllowed` writes have succeeded.
 */
export function faulty<Handle extends FileSystemHandle>(handle: Handle, faults: Faults): Handle {
  const proxy: Handle = new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'move' && !faults.keepMove) return undefined;
      if (typeof value !== 'function') return value;
      const method = value as (...parameters: unknown[]) => unknown;
      const call = (...args: unknown[]): unknown => method.apply(target, args.map(unwrapped));
      if (property === 'entries') {
        return () => wrappedEntries(target as unknown as FileSystemDirectoryHandle, faults);
      }
      if (property === 'createWritable') {
        return async () => writableThatFails(faults, await (call() as Promise<FileSystemWritableFileStream>));
      }
      if (property === 'removeEntry') {
        return async (name: string, options?: unknown) =>
          call(await nameAsStored(target as unknown as FileSystemDirectoryHandle, name, faults), options);
      }
      if (property === 'getFileHandle' || property === 'getDirectoryHandle') {
        return async (requested: string, options?: unknown) => {
          const name = await nameAsStored(target as unknown as FileSystemDirectoryHandle, requested, faults);
          if (faults.rejectNamesWith && name.includes(faults.rejectNamesWith)) {
            throw new TypeError('bad name');
          }
          return faulty((await call(name, options)) as FileSystemHandle, faults);
        };
      }
      return call;
    },
  });
  originals.set(proxy, handle);
  return proxy;
}
