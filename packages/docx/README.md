# @scope/docx

A Word renderer for the file workspace: .docx files laid out in pages by docx-preview and sanitized before they are shown.

It opens .docx up to 25 MiB. docx-preview loads the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @scope/docx @scope/react react react-dom
```

`@scope/react` and `react` are peer dependencies. If you want every renderer at once, install `@scope/workspace` instead.

## Entry

`docxRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@scope/core/http';
import { lightRenderers, Workspace } from '@scope/react';
import { docxRenderer } from '@scope/docx';
import '@scope/react/styles.css';
import '@scope/docx/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [docxRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`DocxViewer` shows one file without a tree or a provider.

```tsx
import { DocxViewer } from '@scope/docx';
import '@scope/react/styles.css';
import '@scope/docx/styles.css';

export function Preview(): React.JSX.Element {
  return <DocxViewer src="/files/letter.docx" fileName="letter.docx" />;
}
```

`src` is a URL, a `Blob`, an `ArrayBuffer` or a `Uint8Array`.

## CSS

Import `@scope/react/styles.css` and `@scope/docx/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@scope/workspace`, its single `@scope/workspace/styles.css` covers every package.

## Options

- `classNames`: classes for this package's `docx-*` parts.
- There are no other options. Scripts, frames and embedded HTML are always removed, only `http(s):` and `mailto:` links survive, and nothing outside the file is fetched. Legacy `.doc` files are not supported.

Pass them to the factory, as in `docxRenderer({ classNames: { 'docx-document': 'pages' } })`. `DocxViewer` takes `classNames` as a prop.

## Vite

No configuration is needed in a build or in the dev server.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/docx).
