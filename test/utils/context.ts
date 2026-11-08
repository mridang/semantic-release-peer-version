import type {
  AnalyzeCommitsContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { recordingLogger } from './logger.js';

/**
 * Build a semantic-release context for a step. The real context carries far
 * more than the plugin reads, so the fields the plugin uses are filled in and
 * the rest is left out; this is the one place the test suite does that.
 *
 * @param extra Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function stepContext<T extends VerifyConditionsContext>(
  extra: Readonly<Record<string, unknown>> = {},
): { context: T; lines: string[] } {
  const { logger, lines } = recordingLogger();
  const context: unknown = {
    logger,
    cwd: process.cwd(),
    env: {},
    commits: [],
    lastRelease: {},
    ...extra,
  };
  return { context: context as T, lines };
}

/**
 * Build a commit the way semantic-release hands it to `analyzeCommits`.
 *
 * @param header The commit subject.
 * @returns A commit with just the fields the analyzer reads.
 */
export const commit = (header: string): Readonly<Record<string, unknown>> => ({
  header,
  message: header,
});

export type AnalyzeContext = AnalyzeCommitsContext & {
  majorCapFromUpstream?: number;
};
