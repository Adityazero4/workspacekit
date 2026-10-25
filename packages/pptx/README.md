# @workspacekit/pptx

A PowerPoint renderer for the file workspace: .pptx slides in a virtualized list, each drawn in its own shadow root.

It opens .pptx up to 200 MiB. The presentation renderer loads the first time such a file opens, so importing this package costs only a small registry entry.

## Install

```sh
npm install @workspacekit/pptx @workspacekit/react react react-dom
```

`@workspacekit/react` and `react` are peer dependencies. If you want every renderer at once, install `@workspacekit/workspace` instead.

## Entry

`pptxRenderer()` returns a renderer. Add it before `lightRenderers` so it wins for its own files, and pass the array to `Workspace`. Create the array once, at module level.

```tsx
import { httpAdapter } from '@workspacekit/core/http';
import { lightRenderers, Workspace } from '@workspacekit/react';
import { pptxRenderer } from '@workspacekit/pptx';
import '@workspacekit/react/styles.css';
import '@workspacekit/pptx/styles.css';

const adapter = httpAdapter('/api/files');
const renderers = [pptxRenderer(), ...lightRenderers];

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} style={{ height: '100vh' }} />;
}
```

## Standalone use

`PptxViewer` shows one file without a tree or a provider.

```tsx
import { PptxViewer } from '@workspacekit/pptx';
import '@workspacekit/react/styles.css';
import '@workspacekit/pptx/styles.css';

export function Preview(): React.JSX.Element {
  return <PptxViewer src="/files/deck.pptx" fileName="deck.pptx" />;
}
```

`src` is a URL, a `Blob`, an `ArrayBuffer` or a `Uint8Array`.

## CSS

Import `@workspacekit/react/styles.css` and `@workspacekit/pptx/styles.css` once each. Both live in `@layer fs` and use only `--fs-*` tokens. With `@workspacekit/workspace`, its single `@workspacekit/workspace/styles.css` covers every package.

## Options

- `externalMedia`: `'block'` (default) or `'allow'`. Blocked, a presentation cannot make the browser fetch pictures or posters from other sites. `'allow'` lets any presentation you open make requests to the hosts it names, which reveals your visitor's IP address and the fact that the file was opened, and can be used for tracking. Use it only for files you trust, and pair it with a Content-Security-Policy `img-src` that lists the hosts you accept.
- `classNames`: classes for this package's `pptx-*` parts.

Pass them to the factory, as in `pptxRenderer({ externalMedia: 'block' })`. `PptxViewer` takes the same options as props.

## Vite

No configuration is needed in a build or in the dev server.

Every export is documented with an example in the [API reference](https://docs-ashy-alpha.vercel.app/api/pptx).
