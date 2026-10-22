'use client';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { Renderer, RendererProps } from './registry';

type LazyRendererComponent = LazyExoticComponent<ComponentType<RendererProps>>;
type RendererModule = Awaited<ReturnType<Renderer['load']>>;

const lazyComponentOfRenderer = new WeakMap<Renderer, LazyRendererComponent>();
const failedToLoad = new WeakSet<LazyRendererComponent>();

async function loadRendererModule(renderer: Renderer): Promise<RendererModule> {
  const module = await renderer.load();
  if (!module?.default) {
    throw new TypeError(
      `renderer "${renderer.id}": load() resolved without a default export; export the component as default`,
    );
  }
  return module;
}

/**
 * The renderer's component, loaded with `renderer.load()` on first render under a `Suspense`. One lazy
 * component is kept per renderer object, so every viewer of that renderer shares one load. A failed load (a
 * rejection, a synchronous throw, or a module without a default export) throws to the nearest error boundary
 * on every render until `forgetFailedLoad` lets the next render load again.
 *
 * @example
 * ```tsx
 * const Component = lazyRendererComponent(textRenderer);
 * <Suspense fallback={<Loading />}><Component {...rendererProps} /></Suspense>
 * ```
 */
export function lazyRendererComponent(renderer: Renderer): LazyRendererComponent {
  const cached = lazyComponentOfRenderer.get(renderer);
  if (cached) return cached;
  const component = lazy(() =>
    loadRendererModule(renderer).catch((error: unknown) => {
      failedToLoad.add(component);
      throw error;
    }),
  );
  lazyComponentOfRenderer.set(renderer, component);
  return component;
}

/**
 * Drops the renderer's lazy component when its load failed, so the next `lazyRendererComponent` call loads
 * the code again. A component that loaded, or is loading, is kept.
 *
 * @example
 * ```ts
 * const retry = (): void => {
 *   forgetFailedLoad(renderer);
 *   resetBoundary();
 * };
 * ```
 */
export function forgetFailedLoad(renderer: Renderer): void {
  const cached = lazyComponentOfRenderer.get(renderer);
  if (cached && failedToLoad.has(cached)) lazyComponentOfRenderer.delete(renderer);
}
