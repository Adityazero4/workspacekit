import { loader } from 'fumadocs-core/source';
import { apiDocs, docs } from '../.source/server';

/**
 * The documentation pages and their navigation tree, read from `content/docs`.
 *
 * @example
 * const page = source.getPage(['guide']);
 */
export const source = loader({ baseUrl: '/docs', source: docs.toFumadocsSource() });

/**
 * The API reference pages and their navigation tree, generated into `content/api` by
 * `scripts/api-reference.mjs`.
 *
 * @example
 * const page = apiSource.getPage(['core']);
 */
export const apiSource = loader({ baseUrl: '/api', source: apiDocs.toFumadocsSource() });
