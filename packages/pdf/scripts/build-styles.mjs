import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import postcssNesting from 'postcss-nesting';

const PDFJS_RULES_FOR_PAGE_VIEWS = new Map([
  ['.pdfViewer', '&'],
  ['.pdfViewer .page', '.page'],
  ['.textLayer', '.textLayer'],
  ['.annotationLayer', '.annotationLayer'],
]);
const SCOPE = "[data-fs-part='pdf-viewer']";
const COMMENT = /\/\*[\s\S]*?\*\//g;

const require = createRequire(import.meta.url);
const pdfjsCss = readFileSync(require.resolve('pdfjs-dist/legacy/web/pdf_viewer.css'), 'utf8');
const ownCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < css.length; index++) {
    if (css[index] === '{') depth++;
    if (css[index] === '}' && --depth === 0) {
      blocks.push(css.slice(start, index + 1));
      start = index + 1;
    }
  }
  return blocks;
}

const selectorOf = (block) => block.slice(0, block.indexOf('{')).replace(COMMENT, '').trim();

const pageViewRules = topLevelBlocks(pdfjsCss)
  .filter((block) => PDFJS_RULES_FOR_PAGE_VIEWS.has(selectorOf(block)))
  .map((block) => `${PDFJS_RULES_FOR_PAGE_VIEWS.get(selectorOf(block))} ${block.slice(block.indexOf('{'))}`);
const pdfjsLicence = pdfjsCss.match(COMMENT)[0];
const scopedPageViewRules =
  `  /* pdf.js ${require('pdfjs-dist/package.json').version}: page, text layer and annotation layer rules */\n` +
  `  ${SCOPE} {\n${pageViewRules.join('\n').replace(/^/gm, '    ')}\n  }\n`;

const nestedStyles = `${pdfjsLicence}\n${ownCss.replace(/\}\s*$/, `\n${scopedPageViewRules}}\n`)}`;
const flattened = await postcss([postcssNesting()]).process(nestedStyles, { from: undefined });
writeFileSync(new URL('../dist/styles.css', import.meta.url), flattened.css);
