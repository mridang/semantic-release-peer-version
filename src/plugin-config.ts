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
  readonly commitAnalyzerConfig?: Readonly<Record<string, unknown>>;
}

/**
 * Whether the user gave the commit analyzer any configuration of its own.
 *
 * @param config The `commitAnalyzerConfig` option.
 * @returns True when it is present and not empty.
 */
export function hasCommitAnalyzerConfig(
  config: PluginConfig['commitAnalyzerConfig'],
): config is Readonly<Record<string, unknown>> {
  return config !== undefined && Object.keys(config).length > 0;
}
