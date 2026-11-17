/**
 * @file Builds semantic-release contexts and commits for the tests.
 */

import { recordingLogger } from './logger.js';
import type { VerifyConditionsContext } from 'semantic-release';

/**
 * Build a semantic-release context for a step. The real context carries far
 * more than the plugin reads, so the fields the plugin uses are filled in and
 * the rest is left out; this is the one place the test suite does that.
 * @template T - The context type of the step under test.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * ```ts
 * const { context, lines } = stepContext<VerifyConditionsContext>({ lastRelease: { version: '1.0.0' } });
 * ```
 */
export function stepContext<T extends VerifyConditionsContext>(
  extra: Readonly<Record<string, unknown>> = {},
) {
  const { logger, lines } = recordingLogger();
  const context = {
    logger,
    cwd: process.cwd(),
    env: {},
    commits: [],
    lastRelease: {},
    ...extra,
  };
  return { context: context as unknown as T, lines };
}

/**
 * Build a commit the way semantic-release hands it to `analyzeCommits`.
 * @param header - The commit subject.
 * @returns A commit with just the fields the analyzer reads.
 * @example
 * ```ts
 * commit('feat: add a flag'); // { header: 'feat: add a flag', message: 'feat: add a flag' }
 * ```
 */
export const commit = (header: string) => ({
  header,
  message: header,
});
