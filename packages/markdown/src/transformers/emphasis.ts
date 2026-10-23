import {
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  STRIKETHROUGH,
  type Transformer,
} from '@lexical/markdown';

/**
 * The inline transformers, longest delimiter first so `***both***` is bold and italic (and is written back
 * as `***both***`), then `**`, then `*`; code spans first of all, so nothing inside them is formatted.
 * `__bold__` and `_italic_` are read but written back with `*`. `==highlight==` is left out: it is not
 * GitHub Markdown, so `a == b == c` stays text. Links come last; an image (`![alt](src)`) is read as the
 * text `!` and a link, so it is never fetched and is written back unchanged.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString('***both*** and [a](https://a.example)', INLINE_TRANSFORMERS);
 * ```
 */
export const INLINE_TRANSFORMERS: Transformer[] = [
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
];
