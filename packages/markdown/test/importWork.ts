import { createEditor, ElementNode, TextNode } from 'lexical';
import { afterAll, beforeAll } from 'vitest';
import { $importMarkdown, MARKDOWN_NODES } from '../src/transformers';

export const IMPORT_WORK_BUDGET = 10_000_000;
export const MEASURED_TO_ESTIMATED_CEILING = 8;

const COUNTED_METHODS = ['getTextContent', 'getTextContentSize'] as const;

let charactersTouched = 0;
const restorers: (() => void)[] = [];

function countCharactersTouchedBy(prototype: Record<string, unknown>, name: string): void {
  const original = prototype[name] as (...args: unknown[]) => unknown;
  prototype[name] = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (typeof result === 'string') charactersTouched += result.length;
    if (typeof result === 'number') charactersTouched += result;
    return result;
  };
  restorers.push(() => (prototype[name] = original));
}

export function countEngineWorkInThisFile(): void {
  beforeAll(() => {
    for (const prototype of [TextNode.prototype, ElementNode.prototype]) {
      for (const name of COUNTED_METHODS) {
        if (Object.hasOwn(prototype, name)) countCharactersTouchedBy(prototype as never, name);
      }
    }
  });
  afterAll(() => restorers.splice(0).forEach((restore) => restore()));
}

export function measuredImportWork(body: string): number {
  const editor = createEditor({ nodes: MARKDOWN_NODES, onError: (error) => void Promise.reject(error) });
  charactersTouched = 0;
  editor.update(() => $importMarkdown(body), { discrete: true });
  return charactersTouched;
}
