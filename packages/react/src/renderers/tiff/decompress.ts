const LZW_CLEAR = 256;
const LZW_END = 257;
const LZW_FIRST_FREE = 258;
const LZW_TABLE_SIZE = 4096;
const LZW_MIN_CODE_BITS = 9;
const LZW_MAX_CODE_BITS = 12;

interface LzwTable {
  prefix: Uint16Array;
  firstByte: Uint8Array;
  lastByte: Uint8Array;
  length: Uint16Array;
}

function newLzwTable(): LzwTable {
  const table: LzwTable = {
    prefix: new Uint16Array(LZW_TABLE_SIZE),
    firstByte: new Uint8Array(LZW_TABLE_SIZE),
    lastByte: new Uint8Array(LZW_TABLE_SIZE),
    length: new Uint16Array(LZW_TABLE_SIZE),
  };
  for (let code = 0; code < 256; code++) {
    table.firstByte[code] = code;
    table.lastByte[code] = code;
    table.length[code] = 1;
  }
  return table;
}

function writeLzwString(table: LzwTable, code: number, output: Uint8Array, at: number): number {
  const end = at + (table.length[code] ?? 0);
  let position = end - 1;
  for (let link = code; position >= at; link = table.prefix[link] ?? 0, position--) {
    if (position < output.length) output[position] = table.lastByte[link] ?? 0;
  }
  return end;
}

function readCode(input: Uint8Array, bitPosition: number, bits: number): number {
  const byteAt = bitPosition >>> 3;
  const window = ((input[byteAt] ?? 0) << 16) | ((input[byteAt + 1] ?? 0) << 8) | (input[byteAt + 2] ?? 0);
  return (window >>> (24 - (bitPosition & 7) - bits)) & ((1 << bits) - 1);
}

/**
 * Decodes TIFF LZW (most significant bit first, early code-width change) into `output`, stopping once it
 * is full or the data ends, so a strip can never write or loop past the size its page declares.
 *
 * @example
 * ```ts
 * decodeLzw(stored, new Uint8Array(rowBytes * rows));
 * ```
 */
export function decodeLzw(input: Uint8Array, output: Uint8Array): void {
  const table = newLzwTable();
  let bits = LZW_MIN_CODE_BITS;
  let nextCode = LZW_FIRST_FREE;
  let previous = -1;
  let written = 0;
  let position = 0;
  while (position + bits <= input.length * 8 && written < output.length) {
    const code = readCode(input, position, bits);
    position += bits;
    if (code === LZW_END) return;
    if (code === LZW_CLEAR) {
      bits = LZW_MIN_CODE_BITS;
      nextCode = LZW_FIRST_FREE;
      previous = -1;
      continue;
    }
    if (code > nextCode || (previous < 0 && code >= LZW_CLEAR)) return;
    if (previous >= 0 && nextCode < LZW_TABLE_SIZE) {
      table.prefix[nextCode] = previous;
      table.firstByte[nextCode] = table.firstByte[previous] ?? 0;
      table.lastByte[nextCode] = table.firstByte[code === nextCode ? previous : code] ?? 0;
      table.length[nextCode] = (table.length[previous] ?? 0) + 1;
      nextCode++;
      if (nextCode + 1 === 1 << bits && bits < LZW_MAX_CODE_BITS) bits++;
    }
    written = writeLzwString(table, code, output, written);
    previous = code;
  }
}

/**
 * Decodes PackBits into `output`, stopping once it is full, so a run can never expand past the size the
 * page declares.
 *
 * @example
 * ```ts
 * decodePackBits(stored, new Uint8Array(rowBytes * rows));
 * ```
 */
export function decodePackBits(input: Uint8Array, output: Uint8Array): void {
  let read = 0;
  let written = 0;
  while (read < input.length && written < output.length) {
    const header = ((input[read++] ?? 0) << 24) >> 24;
    if (header >= 0) {
      const literal = input.subarray(read, read + header + 1).subarray(0, output.length - written);
      output.set(literal, written);
      written += literal.length;
      read += header + 1;
    } else if (header !== -128) {
      const runEnd = Math.min(written + 1 - header, output.length);
      output.fill(input[read++] ?? 0, written, runEnd);
      written = runEnd;
    }
  }
}

const isZlibStream = (input: Uint8Array): boolean => {
  const [method = 0, flags = 0] = input;
  return (method & 0x0f) === 8 && ((method << 8) | flags) % 31 === 0;
};

/**
 * Inflates Deflate data (zlib-wrapped, or raw) into `output` with the browser's `DecompressionStream`,
 * aborting as soon as it would produce more than `output` holds, so a small strip cannot expand into
 * gigabytes. Output that fills `output` exactly and is then followed by a stream error (trailing padding)
 * is accepted; any other stream error rejects.
 *
 * @example
 * ```ts
 * await inflateInto(stored, new Uint8Array(rowBytes * rows));
 * ```
 */
export async function inflateInto(input: Uint8Array<ArrayBuffer>, output: Uint8Array): Promise<void> {
  const inflater = new DecompressionStream(isZlibStream(input) ? 'deflate' : 'deflate-raw');
  const writer = inflater.writable.getWriter();
  writer
    .write(input)
    .then(
      () => writer.close(),
      () => undefined,
    )
    .catch(() => undefined);
  const reader = inflater.readable.getReader();
  let written = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (written + chunk.value.byteLength > output.length) {
        throw new RangeError('This strip inflates past the size its page declares; the file may be corrupt');
      }
      output.set(chunk.value, written);
      written += chunk.value.byteLength;
    }
  } catch (thrown) {
    if (thrown instanceof RangeError || written < output.length) throw thrown;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
