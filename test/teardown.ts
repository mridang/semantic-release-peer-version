/**
 * @file Global Jest teardown, which has no external services to stop.
 */

/* noinspection JSUnusedGlobalSymbols */

/**
 * Clean up after the test run, once every test file has finished.
 * @example
 * ```ts
 * // Jest calls this once through globalTeardown in jest.config.mjs.
 * await teardown();
 * ```
 */
export default async function teardown(): Promise<void> {
  // No external services to tear down.
}
