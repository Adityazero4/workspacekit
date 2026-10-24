import { gradientImage, salesWorkbook, welcomeDocument } from './binarySamples';

const README = `# Demo project

A small project for trying the file workspace. Open a file in the tree to see how it renders, and edit anything: changes save on their own.

- \`src/index.ts\` is a TypeScript module.
- \`data/sales.csv\` and \`data/sales.xlsx\` are spreadsheets.
- \`docs/welcome.pdf\` is a PDF.
`;

const PACKAGE_JSON = `{
  "name": "demo-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "build": "tsc" }
}
`;

const INDEX_SOURCE = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const SALES_CSV = 'Region,Q1,Q2\nNorth,120,135\nSouth,98,110\nEast,143,151\n';

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="16" fill="#4f46e5"/>
  <path d="M24 30h28l8 8h12v28H24z" fill="#ffffff"/>
</svg>
`;

/**
 * A small project tree for examples and docs: Markdown, TypeScript, JSON, CSV, an SVG, and an XLSX, a PDF and
 * a PNG that are generated in code. The result is the same on every call, so it can seed a memory adapter
 * and be compared in tests.
 *
 * @example
 * ```ts
 * const adapter = createMemoryAdapter({ files: sampleFiles() });
 * ```
 */
export function sampleFiles(): Record<string, string | Uint8Array> {
  return {
    'README.md': README,
    'package.json': PACKAGE_JSON,
    'src/index.ts': INDEX_SOURCE,
    'data/sales.csv': SALES_CSV,
    'data/sales.xlsx': salesWorkbook(),
    'docs/welcome.pdf': welcomeDocument(),
    'assets/logo.svg': LOGO_SVG,
    'assets/gradient.png': gradientImage(),
  };
}
