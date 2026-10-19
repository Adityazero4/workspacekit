export const treeRowRenders = { updates: 0, mounts: 0 };
export const fileTabRenders = { updates: 0, mounts: 0 };

const PERFORMED_WORK = 1;

interface Fiber {
  type: unknown;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

const countersByComponentName: Record<string, { updates: number; mounts: number }> = {
  TreeRow: treeRowRenders,
  FileTab: fileTabRenders,
};

const counterOf = (fiber: Fiber): { updates: number; mounts: number } | undefined =>
  typeof fiber.type === 'function' ? countersByComponentName[fiber.type.name] : undefined;

function countRowsThatRendered(next: Fiber, previous: Fiber | null): void {
  const counter = counterOf(next);
  if (counter) {
    if (!previous) counter.mounts++;
    else if (next.flags & PERFORMED_WORK) counter.updates++;
  }
  const subtreeWasSkipped = previous !== null && next.child === previous.child;
  if (subtreeWasSkipped) return;
  for (let child = next.child; child; child = child.sibling) countRowsThatRendered(child, child.alternate);
}

Object.assign(globalThis, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_rendererId: number, root: { current: Fiber }) =>
      countRowsThatRendered(root.current, root.current.alternate),
  },
});
