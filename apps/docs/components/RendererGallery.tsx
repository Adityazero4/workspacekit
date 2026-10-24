'use client';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { sampleFiles } from '@workspacekit/demo-kit';
import { allRenderers, FileSystemProvider, FileViewer } from '@workspacekit/workspace';
import '@workspacekit/workspace/styles.css';
import { useTheme } from 'fumadocs-ui/provider/base';
import { useState, type KeyboardEvent } from 'react';

const GALLERY: readonly { label: string; path: string }[] = [
  { label: 'PDF', path: 'docs/welcome.pdf' },
  { label: 'Spreadsheet', path: 'data/sales.xlsx' },
  { label: 'Markdown', path: 'README.md' },
  { label: 'Code', path: 'src/index.ts' },
  { label: 'Image', path: 'assets/gradient.png' },
];

const renderers = allRenderers();

function nextTabIndex(key: string, index: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % GALLERY.length;
  if (key === 'ArrowLeft') return (index - 1 + GALLERY.length) % GALLERY.length;
  if (key === 'Home') return 0;
  if (key === 'End') return GALLERY.length - 1;
  return null;
}

/**
 * Tabs that open one sample file each (PDF, spreadsheet, Markdown, code, image) in its viewer.
 *
 * @example
 * ```tsx
 * <RendererGallery />
 * ```
 */
export function RendererGallery(): React.JSX.Element {
  const [adapter] = useState(() => createMemoryAdapter({ files: sampleFiles() }));
  const [selected, setSelected] = useState(0);
  const { resolvedTheme } = useTheme();
  const current = GALLERY[selected] ?? GALLERY[0]!;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = nextTabIndex(event.key, index);
    if (target === null) return;
    event.preventDefault();
    setSelected(target);
    document.getElementById(`gallery-tab-${target}`)?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label="Renderers" className="mb-3 flex flex-wrap gap-2">
        {GALLERY.map((item, index) => (
          <button
            key={item.path}
            id={`gallery-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === selected}
            aria-controls="gallery-panel"
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => moveFocus(event, index)}
            className="rounded-md border border-fd-border px-3 py-1.5 text-sm font-medium text-fd-foreground aria-selected:bg-fd-primary aria-selected:text-fd-primary-foreground"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id="gallery-panel"
        role="tabpanel"
        aria-labelledby={`gallery-tab-${selected}`}
        data-theme={resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : undefined}
        className="h-[480px] overflow-hidden rounded-lg border border-fd-border"
      >
        <FileSystemProvider adapter={adapter}>
          <FileViewer key={current.path} path={current.path} renderers={renderers} />
        </FileSystemProvider>
      </div>
    </div>
  );
}
