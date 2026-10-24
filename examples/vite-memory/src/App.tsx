import { createMemoryAdapter } from '@workspacekit/core/memory';
import type { FileSystemAdapter } from '@workspacekit/core';
import { sampleFiles, simulateAgent } from '@workspacekit/demo-kit';
import { Workspace } from '@workspacekit/workspace';
import '@workspacekit/workspace/styles.css';
import { useEffect, useState } from 'react';
import './app.css';
import { fileSystemAccessAdapter } from './fileSystemAccessAdapter';

type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

const showDirectoryPicker: DirectoryPicker | undefined = (
  window as unknown as { showDirectoryPicker?: DirectoryPicker }
).showDirectoryPicker?.bind(window);

const isUserCancellation = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

function OpenFolderButton(props: {
  pick: DirectoryPicker;
  onOpen: (root: FileSystemDirectoryHandle) => void;
}): React.JSX.Element {
  const [failure, setFailure] = useState<string | null>(null);
  const openFolder = async (): Promise<void> => {
    try {
      setFailure(null);
      props.onOpen(await props.pick({ mode: 'readwrite' }));
    } catch (error) {
      if (!isUserCancellation(error)) setFailure(`Could not open the folder: ${String(error)}`);
    }
  };
  return (
    <>
      <button type="button" onClick={() => void openFolder()}>
        Open a folder
      </button>
      {failure && <span role="alert">{failure}</span>}
    </>
  );
}

function useSimulatedAgent(sampleAdapter: ReturnType<typeof createMemoryAdapter>, isOn: boolean): void {
  useEffect(() => {
    if (!isOn) return;
    const controller = new AbortController();
    simulateAgent(sampleAdapter, { signal: controller.signal });
    return () => controller.abort();
  }, [sampleAdapter, isOn]);
}

/**
 * The example: a `Workspace` over sample files held in memory, with a simulated agent that edits them, and a
 * button that swaps in a folder from the user's disk where the browser supports it.
 *
 * @example
 * ```tsx
 * createRoot(document.getElementById('root')!).render(<App />);
 * ```
 */
export function App(): React.JSX.Element {
  const [sampleAdapter] = useState(() => createMemoryAdapter({ files: sampleFiles() }));
  const [folder, setFolder] = useState<{ adapter: FileSystemAdapter; id: string } | null>(null);
  const [isAgentOn, setIsAgentOn] = useState(false);
  useSimulatedAgent(sampleAdapter, isAgentOn && folder === null);

  return (
    <div className="app">
      <header className="app-bar">
        <h1>File workspace</h1>
        {folder === null ? (
          <label>
            <input type="checkbox" checked={isAgentOn} onChange={(e) => setIsAgentOn(e.target.checked)} />{' '}
            Simulated agent
          </label>
        ) : (
          <button type="button" onClick={() => setFolder(null)}>
            Back to the sample files
          </button>
        )}
        {showDirectoryPicker && (
          <OpenFolderButton
            pick={showDirectoryPicker}
            onOpen={(root) => setFolder({ adapter: fileSystemAccessAdapter(root), id: crypto.randomUUID() })}
          />
        )}
      </header>
      <main className="app-workspace">
        <Workspace
          key={folder?.id ?? 'sample'}
          adapter={folder?.adapter ?? sampleAdapter}
          style={{ height: '100%' }}
        />
      </main>
    </div>
  );
}
