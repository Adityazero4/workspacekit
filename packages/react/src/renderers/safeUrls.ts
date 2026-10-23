const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'blob:']);
const PLAYABLE_MEDIA = /^(image|audio|video)\//;
const BASE64_CHUNK = 0x8000;

function parsedUrlOrNull(url: string): URL | null {
  try {
    return new URL(url, location.href);
  } catch {
    return null;
  }
}

/**
 * The absolute form of `url` (an adapter's answer, a link inside a document) when it is http, https or
 * blob; `null` otherwise (such as `javascript:` or `data:`), so the URL can never run script when it is
 * followed, downloaded or shown.
 *
 * @example
 * ```tsx
 * const href = safeUrlOrNull(link.url);
 * return href ? <a href={href} target="_blank" rel="noopener noreferrer">{link.text}</a> : link.text;
 * ```
 */
export function safeUrlOrNull(url: string): string | null {
  const parsed = parsedUrlOrNull(url);
  return parsed && SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}

function mediaTypeOf(blob: Blob, fileName: string): string {
  const type = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
  const isUntyped = type === '' || type === 'application/octet-stream';
  return isUntyped && fileName.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : type;
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }
  return btoa(binary);
}

async function svgDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  return `data:image/svg+xml;base64,${base64Of(bytes)}`;
}

/**
 * A URL an `img`, `audio` or `video` element can show `blob` from, typed so it can never render as a page.
 * An SVG (by type, or an untyped blob named `*.svg`) becomes a `data:` URL, whose opaque origin cannot act
 * as the app. Otherwise it is an object URL (`objectUrl` is set; revoke it when done): inert `image/*`,
 * `audio/*` and `video/*` keep their type, anything else becomes `application/octet-stream`.
 *
 * @example
 * ```ts
 * const { url, objectUrl } = await mediaUrlOfBlob(blob, 'photo.png', signal);
 * ```
 */
export async function mediaUrlOfBlob(
  blob: Blob,
  fileName: string,
  signal: AbortSignal,
): Promise<{ url: string; objectUrl?: string }> {
  const type = mediaTypeOf(blob, fileName);
  if (type === 'image/svg+xml') return { url: await svgDataUrl(blob, signal) };
  const isInertMedia = PLAYABLE_MEDIA.test(type) && !type.includes('html') && !type.includes('xml');
  const url = URL.createObjectURL(isInertMedia ? blob : blob.slice(0, blob.size, 'application/octet-stream'));
  return { url, objectUrl: url };
}
