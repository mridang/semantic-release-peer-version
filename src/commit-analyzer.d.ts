declare module '@semantic-release/commit-analyzer' {
  import type { AnalyzeCommitsContext } from 'semantic-release';

  /**
   * Determine the release type from the commits in the context. The package
   * ships no types of its own.
   *
   * @param pluginConfig The commit analyzer configuration.
   * @param context The semantic-release context.
   * @returns The release type, or null when no release is warranted.
   */
  export function analyzeCommits(
    pluginConfig: Readonly<Record<string, unknown>>,
    context: AnalyzeCommitsContext,
  ): Promise<string | null>;
}
