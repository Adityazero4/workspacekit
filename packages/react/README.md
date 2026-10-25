# @workspacekit/react

The React file workspace: a virtualized file tree, search, tabs, upload and viewers, in one `Workspace` component, plus every building block it is made of.

It renders text, HTML, images, audio and video out of the box. For PDF, Word, PowerPoint, spreadsheets, Markdown and code, install `@workspacekit/workspace`, which adds the renderer packages.

## Install

```sh
npm install @workspacekit/react @workspacekit/core react react-dom
```

## Entry

`Workspace` takes an adapter and fills its parent, so give it a height.

```tsx
'use client';
import { httpAdapter } from '@workspacekit/core/http';
import { Workspace } from '@workspacekit/react';
import '@workspacekit/react/styles.css';

const adapter = httpAdapter('/api/files');

export default function Files(): React.JSX.Element {
  return <Workspace adapter={adapter} style={{ height: '100vh' }} />;
}
```

## Use the parts on their own

`FileSystemProvider` owns the tree store. Everything below it reads it through hooks.

```tsx
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { FileSearch, FileSystemProvider, FileTree } from '@workspacekit/react';
import '@workspacekit/react/styles.css';

const adapter = createMemoryAdapter({ files: { 'README.md': '# Hello' } });

export function Browser(): React.JSX.Element {
  return (
    <FileSystemProvider adapter={adapter}>
      <FileSearch />
      <FileTree />
    </FileSystemProvider>
  );
}
```

## Standalone viewers

`@workspacekit/react/renderers` exports the light viewers, which take a file and need no provider.

```tsx
import { TextViewer } from '@workspacekit/react/renderers';
import '@workspacekit/react/styles.css';

export function Note(): React.JSX.Element {
  return <TextViewer src={new Blob(['Hello'])} fileName="note.txt" />;
}
```

## Write a renderer

`@workspacekit/react/renderer-kit` is the public API for renderer packages. `defineRenderer` registers a viewer for the files it matches; pass the result to `Workspace` in `renderers`.

```tsx
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { lightRenderers, Workspace } from '@workspacekit/react';
import { defineRenderer, MATCH_SCORE, type RendererProps } from '@workspacekit/react/renderer-kit';

function Plain({ source }: RendererProps): React.JSX.Element {
  return <pre>{source.kind === 'text' ? source.text : ''}</pre>;
}

const logRenderer = defineRenderer({
  id: 'log',
  match: (file) => file.extension === 'log' && MATCH_SCORE.specific,
  load: async () => ({ default: Plain }),
  input: 'text',
  maxBytes: 1024 * 1024,
});

const adapter = createMemoryAdapter({ files: { 'run.log': 'started' } });
const renderers = [logRenderer, ...lightRenderers];

export function Logs(): React.JSX.Element {
  return <Workspace adapter={adapter} renderers={renderers} />;
}
```

Create the renderer array once, at module level.

## CSS

Import `@workspacekit/react/styles.css` once. It lives in `@layer fs`, so your own CSS wins without `!important`. Every element has a `data-fs-part` attribute and uses `--fs-*` tokens. Light and dark follow `prefers-color-scheme`; set `data-theme="light"` or `"dark"` on any ancestor to override.

## Options

- `adapter`: required. Create it once.
- `root`, `fetchDepth`, `hidden`, `storageKey`: which folder to show, how deep to list, which names to hide, and the key under which UI state is saved.
- `renderers`: the viewers to use. Default `lightRenderers`.
- `theme`, `classNames`, `className`, `style`: appearance.
- `actions`, `canPerform`, `components`: extra tree actions, a per-entry policy, and replacement menus and dialogs.
- `onError`, `onNotify`, `onUploadConflict`: hooks for failures, notices and upload conflicts.

Every export is documented with an example in the [API reference](https://docs-ashy-alpha.vercel.app/api/react).
