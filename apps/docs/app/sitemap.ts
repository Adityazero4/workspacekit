import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/layoutOptions';
import { apiSource, source } from '../lib/source';

/**
 * Written once at build time, since the site is a static export.
 *
 * @example
 * export { dynamic } from './sitemap';
 */
export const dynamic = 'force-static';

/**
 * Every page of the site, for search engines: the home page, the guides and the API reference.
 *
 * @example
 * const entries = sitemap();
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [...source.getPages(), ...apiSource.getPages()].map((page) => `${SITE_URL}${page.url}/`);
  return [`${SITE_URL}/`, ...pages].map((url) => ({ url }));
}
