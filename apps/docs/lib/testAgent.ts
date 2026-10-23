/**
 * The pause before each step of the landing demo's agent in test builds, short so end-to-end tests see
 * several steps and can prove the agent stopped.
 *
 * @example
 * const waitForThreeSteps = 3 * TEST_AGENT_INTERVAL_MS;
 */
export const TEST_AGENT_INTERVAL_MS = 200;
