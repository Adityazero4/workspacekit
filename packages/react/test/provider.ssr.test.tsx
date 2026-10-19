// @vitest-environment node
import { createMemoryAdapter } from '@scope/core/memory';
import { renderToString } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import {
  useEntryState,
  useExpanded,
  useSelected,
  useTreeSnapshot,
  useUiValue,
  useFileSystem,
} from '../src/provider/hooks';

test('server rendering renders the children without touching the adapter', () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const list = vi.spyOn(adapter, 'list');
  const watch = vi.spyOn(adapter, 'watch');
  const Probe = (): React.JSX.Element => {
    const { status } = useEntryState('');
    const { version } = useTreeSnapshot();
    const sort = useUiValue(useFileSystem().sort);
    const expanded = useExpanded('a');
    const selected = useSelected('a');
    return <p>{`probe:${status}:${version}:${sort.by}:${expanded}:${selected}`}</p>;
  };
  const html = renderToString(
    <FileSystemProvider adapter={adapter} storageKey="ws">
      <Probe />
    </FileSystemProvider>,
  );
  expect(html).toContain('probe:idle:0:name:false:false');
  expect(list).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
});
