'use client';
import { useEffect, useRef } from 'react';

/**
 * The 3D workspacekit mark for the hero. three.js loads only in the browser, after the page, and nothing
 * renders where WebGL is unavailable.
 *
 * @example
 * <HeroModel />
 */
export function HeroModel(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let isMounted = true;
    void import('./heroScene')
      .then(({ mountHeroScene }) => {
        if (isMounted && host.current) stop = mountHeroScene(host.current);
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
      stop?.();
    };
  }, []);
  return (
    <div className="relative aspect-square w-full">
      <div
        aria-hidden="true"
        className="absolute inset-[18%] rounded-full bg-[radial-gradient(circle,rgb(255_94_98/0.22),rgb(255_153_102/0.08)_45%,transparent_70%)] blur-2xl"
      />
      <div ref={host} aria-hidden="true" className="absolute inset-0 [&>canvas]:size-full" />
    </div>
  );
}
