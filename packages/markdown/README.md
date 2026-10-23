# @scope/markdown

A Markdown renderer for the file workspace: an editable rendered view with a source mode, built on Lexical.

It opens .md, .markdown, .mkd and .mdown up to 10 MiB. Lexical loads the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @scope/markdown @scope/code @scope/react react react-dom
```

`@scope/react` and `react` are peer dependencies. If you want every renderer at once, install `@scope/workspace` instead.

## Entry

`markdownRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@scope/core/http';
import { lightRenderers, Workspace } from '@scope/react';
import { codeRenderer } from '@scope/code';
import { markdownRenderer } from '@scope/markdown';
import '@scope/react/styles.css';
import '@scope/markdown/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [markdownRenderer({ source: codeRenderer() }), codeRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`MarkdownEditor` shows one file without a tree or a provider.

```tsx
import { MarkdownEditor } from '@scope/markdown';
import '@scope/react/styles.css';
import '@scope/markdown/styles.css';

export function Editor(): React.JSX.Element {
  return <MarkdownEditor value="# Hello" onChange={() => undefined} />;
}
```

Pass the text as `value` and listen with `onChange`; `mode` is `'rendered'` or `'source'`.

## CSS

Import `@scope/react/styles.css` and `@scope/markdown/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@scope/workspace`, its single `@scope/workspace/styles.css` covers every package.

## Options

- `source`: the renderer that draws source mode. Default is the light text renderer; pass `codeRenderer()` from `@scope/code` for syntax highlighting.
- `classNames`: classes for this package's `md-*` parts.

Pass them to the factory, as in `markdownRenderer({ source: codeRenderer() })`. `MarkdownEditor` takes `classNames` as a prop and `sourceEditor` for the source view.

## Vite

No configuration is needed in a build or in the dev server.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/markdown).
