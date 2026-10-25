/**
 * The documentation site's address, in one place so the examples, the site, the generated files and the
 * error messages agree.
 *
 * @example
 * ```ts
 * const guide = `${DOCS_URL}/docs/getting-started/next`;
 * ```
 */
export const DOCS_URL: string = 'https://docs-ashy-alpha.vercel.app';

/**
 * The address of a documentation page, and of a heading on it, for error messages that point at the fix.
 * `page` is the path under `/docs`, without a leading slash.
 *
 * @example
 * ```ts
 * docsLink('server/handler', 'authorize');
 * ```
 */
export function docsLink(page: string, anchor?: string): string {
  return `${DOCS_URL}/docs/${page}${anchor === undefined ? '' : `#${anchor}`}`;
}
