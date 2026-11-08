/**
 * Plugin configuration, as given in the semantic-release config.
 */
export interface PluginConfig {
  /**
   * GitHub repository in the form `owner/repo`.
   */
  readonly repo: string;

  /**
   * Optional GitHub token for authenticated API requests.
   */
  readonly githubToken?: string;

  /**
   * Optional configuration for the underlying commit analyzer. Defaults to
   * the `conventionalcommits` preset.
   */
  readonly commitAnalyzerConfig?: Readonly<Record<string, unknown>> | null;
}

/**
 * The commit analyzer configuration the user gave, if it has any options.
 *
 * @param config The plugin configuration.
 * @returns The `commitAnalyzerConfig` option, or undefined when it is missing
 * or empty.
 */
export function customCommitAnalyzerConfig(
  config: PluginConfig,
): Readonly<Record<string, unknown>> | undefined {
  const { commitAnalyzerConfig } = config;
  return commitAnalyzerConfig != null &&
    Object.keys(commitAnalyzerConfig).length > 0
    ? commitAnalyzerConfig
    : undefined;
}
