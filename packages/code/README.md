# @scope/code

A code renderer for the file workspace: an editable CodeMirror 6 editor with syntax highlighting for code, configuration and data files.

It opens files such as .ts, .json, .yaml, Makefile and .env up to 10 MiB. CodeMirror loads the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @scope/code @scope/react react react-dom
```

`@scope/react` and `react` are peer dependencies. If you want every renderer at once, install `@scope/workspace` instead.

## Entry

`codeRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@scope/core/http';
import { lightRenderers, Workspace } from '@scope/react';
import { codeRenderer } from '@scope/code';
import '@scope/react/styles.css';
import '@scope/code/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [codeRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`CodeViewer` shows one file without a tree or a provider.

```tsx
import { CodeViewer } from '@scope/code';
import '@scope/react/styles.css';
import '@scope/code/styles.css';

export function Preview(): React.JSX.Element {
  return <CodeViewer src={new Blob(['export const answer = 42;'])} fileName="answer.ts" />;
}
```

`src` is a URL, a `Blob`, an `ArrayBuffer` or a `Uint8Array`.

## CSS

Import `@scope/react/styles.css` and `@scope/code/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@scope/workspace`, its single `@scope/workspace/styles.css` covers every package.

## Options

- `nonce`: set on the `<style>` elements CodeMirror adds, for a strict `style-src` Content-Security-Policy.
- `classNames`: classes for this package's `code-*` parts.

Pass them to the factory, as in `codeRenderer({ nonce })`. `CodeViewer` takes `nonce` and `classNames` as props, plus `language` to override the language chosen from the file name; `CodeEditor` is the same editor with `value` and `onChange`.

## Vite

No configuration is needed in a build or in the dev server.

Every export is documented with an example in the [API reference](https://docs.example.invalid/api/code).
