import { ChangeFlow } from '../../components/landing/ChangeFlow';
import { Faq } from '../../components/landing/Faq';
import { Hero } from '../../components/landing/Hero';
import { Inside } from '../../components/landing/Inside';
import { ForAgents, Layers } from '../../components/landing/Packages';
import { Closing, Comparison, Gallery, QuickStart, Security } from '../../components/landing/Sections';

/**
 * The landing page: the live demo, how a change reaches the screen, what is inside, the viewers, building
 * it yourself, security, the quick start, the packages, coding agents and common questions.
 *
 * @example
 * <HomePage />
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className="flex w-full flex-col">
      <Hero />
      <ChangeFlow />
      <Inside />
      <Gallery />
      <Comparison />
      <Security />
      <QuickStart />
      <Layers />
      <ForAgents />
      <Faq />
      <Closing />
    </div>
  );
}
