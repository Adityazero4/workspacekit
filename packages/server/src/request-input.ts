import { FsError } from '@scope/core';

const MAX_JSON_BYTES = 1024 * 1024;

/**
 * An `invalid` error naming the request problem, and the path it concerns when known.
 *
 * @example
 * throw invalidRequest('depth must be a non-negative integer', 'src');
 */
export function invalidRequest(message: string, path?: string): FsError {
  return new FsError('invalid', message, path === undefined ? {} : { path });
}

/**
 * Rejects a request whose declared `Content-Length` already exceeds `max`, before reading its body.
 *
 * @example
 * rejectDeclaredTooLarge(request, 10 * 1024 * 1024, 'notes.md');
 */
export function rejectDeclaredTooLarge(request: Request, max: number, path?: string): void {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    throw new FsError('too_large', `exceeds ${max} bytes`, path === undefined ? {} : { path });
  }
}

async function readCapped(request: Request, max: number): Promise<Uint8Array[]> {
  const reader = request.body?.getReader();
  if (!reader) throw invalidRequest('missing request body');
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      received += value.byteLength;
      if (received > max) throw new FsError('too_large', `request body exceeds ${max} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

/**
 * Reads a JSON object body of at most 1 MiB, rejecting anything else as `invalid` (or `too_large`).
 *
 * @example
 * const body = (await readJsonObject(request)) as Partial<CreateBody>;
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  rejectDeclaredTooLarge(request, MAX_JSON_BYTES);
  const chunks = await readCapped(request, MAX_JSON_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw invalidRequest('request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidRequest('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * `value` when it is a string, else an `invalid` error naming the field.
 *
 * @example
 * const path = requireString(body.path, 'path');
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw invalidRequest(`${name} must be a string`);
  return value;
}

/**
 * `true` only for `true`; `undefined` reads as `false`, and any other value is an `invalid` error naming the
 * field.
 *
 * @example
 * const overwrite = optionalBoolean(body.overwrite, 'overwrite');
 */
export function optionalBoolean(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw invalidRequest(`${name} must be a boolean`);
  return value === true;
}

/**
 * A query parameter holding a non-negative integer of at most 15 digits, else an `invalid` error naming it.
 *
 * @example
 * const index = nonNegativeIntegerParam(url.searchParams.get('index'), 'index');
 */
export function nonNegativeIntegerParam(value: string | null, name: string): number {
  if (value === null || !/^\d{1,15}$/.test(value)) {
    throw invalidRequest(`${name} must be a non-negative integer`);
  }
  return Number(value);
}
