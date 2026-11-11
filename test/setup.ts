/**
 * @file Global Jest setup, which starts nothing because no external services are needed.
 */

/* noinspection JSUnusedGlobalSymbols */

/**
 * Prepare the test run before any test file loads.
 * @example
 * ```ts
 * // Jest calls this once through globalSetup in jest.config.mjs.
 * await setup();
 * ```
 */
export default async function setup(): Promise<void> {
  // No external services are required for the test suite.
}
