import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/layoutOptions';

/**
 * Written once at build time, since the site is a static export.
 *
 * @example
 * export { dynamic } from './robots';
 */
export const dynamic = 'force-static';

/**
 * Lets every crawler, AI agents included, read the whole site, and points them at the sitemap. It only takes
 * effect where the site is served from the root of its domain.
 *
 * @example
 * const rules = robots();
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/' }, sitemap: `${SITE_URL}/sitemap.xml` };
}
