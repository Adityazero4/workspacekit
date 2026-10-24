import { ChangeFlow } from '../../components/landing/ChangeFlow';
import { Hero } from '../../components/landing/Hero';
import { Inside } from '../../components/landing/Inside';
import { ForAgents, Layers } from '../../components/landing/Packages';
import { Closing, Comparison, Gallery, QuickStart, Security } from '../../components/landing/Sections';

/**
 * The landing page: the live demo first, then what is inside, how live updates work, why not to build it
 * yourself, security, the quick start, the viewers, the packages and what coding agents get.
 *
 * @example
 * <HomePage />
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className="flex w-full flex-col">
      <Hero />
      <Inside />
      <ChangeFlow />
      <Comparison />
      <Security />
      <QuickStart />
      <Gallery />
      <Layers />
      <ForAgents />
      <Closing />
    </div>
  );
}
