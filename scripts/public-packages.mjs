/**
 * The folders under `packages/` that are published to npm, each as `@workspacekit/<folder>`, and ship
 * `README.md`, `AGENTS.md` and `llms.txt`. This module imports nothing, so a release step can read it before
 * dependencies are installed.
 *
 * @example
 * for (const folder of PUBLIC_PACKAGES) console.log(`packages/${folder}/llms.txt`);
 */
export const PUBLIC_PACKAGES = [
  'core',
  'server',
  'react',
  'code',
  'pdf',
  'docx',
  'pptx',
  'spreadsheet',
  'markdown',
  'workspace',
  'demo-kit',
  'create-workspace',
];
