import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { expect, test, vi } from 'vitest';
import { createMarkdownSync } from '../src/sync';
import { MARKDOWN_NODES } from '../src/transformers';

test('a flush with nothing received yet clears the pending edit, so a later text is still shown', () => {
  const editor = createEditor({ nodes: MARKDOWN_NODES, onError: (error) => void Promise.reject(error) });
  const deliver = vi.fn();
  const sync = createMarkdownSync(editor, { currentDeliver: () => deliver, onReformat: () => {} });
  const container = document.createElement('div');
  const stopWatching = sync.watch(container);
  const stopListening = sync.listen();
  container.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  editor.update(() => void $getRoot().append($createParagraphNode().append($createTextNode('typed'))), {
    discrete: true,
  });
  sync.flush();
  sync.receive('# Arrived\n');
  expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('Arrived');
  expect(deliver).not.toHaveBeenCalled();
  stopListening();
  stopWatching();
});
