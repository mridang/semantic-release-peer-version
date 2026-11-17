/**
 * @file Type declarations for the commit analyzer, which ships none.
 */

declare module '@semantic-release/commit-analyzer' {
  import type { AnalyzeCommitsContext } from 'semantic-release';

  /**
   * The context the analyzer reads. semantic-release types `lastRelease` as
   * complete, but hands over an empty object when nothing was released yet, so
   * its fields are optional here.
   */
  export type AnalyzeContext = Omit<AnalyzeCommitsContext, 'lastRelease'> & {
    readonly lastRelease?: Partial<AnalyzeCommitsContext['lastRelease']>;
  };

  /**
   * Determine the release type from the commits in the context. The package
   * ships no types of its own.
   * @param pluginConfig - The commit analyzer configuration.
   * @param context - The semantic-release context.
   * @returns The release type, or null when no release is warranted.
   * @example
   * ```ts
   * const releaseType = await analyzeCommits({ preset: 'conventionalcommits' }, context); // 'minor'
   * ```
   */
  export function analyzeCommits(
    pluginConfig: unknown,
    context: AnalyzeContext,
  ): Promise<string | null>;
}
