import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({ dir: 'content/docs' });

export const apiDocs = defineDocs({ dir: 'content/api' });

export default defineConfig();
