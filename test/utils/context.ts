/**
 * @file Builds semantic-release contexts and commits for the tests.
 */

import { recordingLogger } from './logger.js';
import type { AnalyzeContext } from '@semantic-release/commit-analyzer';

/**
 * Build a semantic-release context for a step. The real context carries far
 * more than the plugin reads, so the fields the plugin uses are filled in with
 * an empty `lastRelease`, as semantic-release has before the first release;
 * this is the one place the test suite declares the result to be the library's
 * context, which every step accepts.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * ```ts
 * const { context, lines } = stepContext({ lastRelease: { version: '1.0.0' } });
 * ```
 */
export function stepContext(extra: Readonly<Record<string, unknown>> = {}) {
  const { logger, lines } = recordingLogger();
  return {
    context: {
      logger,
      cwd: process.cwd(),
      env: {},
      commits: [],
      releases: [],
      lastRelease: {},
      stdout: process.stdout,
      stderr: process.stderr,
      envCi: { isCi: false, commit: 'abc1234', branch: 'main' },
      branch: { name: 'main' },
      branches: [],
      options: {},
      ...extra,
    } as AnalyzeContext,
    lines,
  };
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
