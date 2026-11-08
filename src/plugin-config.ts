import SemanticReleaseError from '@semantic-release/error';

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
  readonly commitAnalyzerConfig?: unknown;
}

/**
 * The commit analyzer configuration the user gave, if it has any options. As
 * before, any value with keys is handed to the analyzer as it is, which then
 * decides what to make of a string or an array; only a missing, empty or
 * falsy value means the default.
 *
 * @param config The plugin configuration.
 * @returns The `commitAnalyzerConfig` option, or undefined when it is missing
 * or empty.
 */
export function customCommitAnalyzerConfig(
  config: PluginConfig,
): NonNullable<unknown> | undefined {
  const { commitAnalyzerConfig } = config;
  return commitAnalyzerConfig && Object.keys(commitAnalyzerConfig).length > 0
    ? commitAnalyzerConfig
    : undefined;
}

/**
 * An `owner/name` pair: no path tricks, no query, no dot-only segments.
 */
const REPO_PATTERN = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

/**
 * Check the `repo` option before it is put into a URL path.
 *
 * @param repo The `repo` option.
 * @throws {SemanticReleaseError} If it is missing, or is not `owner/name`.
 */
export function assertRepo(repo: unknown): asserts repo is string {
  if (!repo) {
    throw new SemanticReleaseError('Missing required config "repo".');
  }
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
    throw new SemanticReleaseError(
      'Invalid config "repo": expected "owner/name".',
      'EINVALIDREPO',
      'Set `repo` to the upstream GitHub repository in the form `owner/name`, for example `cli/cli`.',
    );
  }
}
