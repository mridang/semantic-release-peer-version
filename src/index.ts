import semver from 'semver';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
// @ts-expect-error since this is not typed
import { analyzeCommits as commitAnalyser } from '@semantic-release/commit-analyzer';
import {
  AnalyzeCommitsContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  BaseContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PluginConfig {
  /**
   * GitHub repository in the form `owner/repo`.
   */
  repo: string;

  /**
   * Optional GitHub token for authenticated API requests.
   */
  githubToken?: string;
}

/**
 * Filter a list of tag names to only those valid semver, sorted descending.
 *
 * @param tagNames - Array of Git tag names
 * @returns Sorted array of valid semver tag names, highest first
 */
const sortSemverTags = (tagNames: string[]): string[] =>
  tagNames
    .filter((tag): boolean => semver.valid(tag) !== null)
    .sort(semver.rcompare);

/**
 * @async
 * @function getLatestSemverTag
 *
 * @description
 * Fetches up to the last 100 releases from the GitHub API for the specified
 * repository. It then identifies all semantically valid version tags (e.g.,
 * "v1.2.3", "1.3.0-beta.1") among these releases and returns the tag
 * corresponding to the highest semantic version.
 *
 * Public repositories can typically be accessed without a GitHub token.
 * However, for private repositories, or to avoid potential rate limiting on
 * public repositories, a GitHub Personal Access Token with the 'repo' scope
 * is required.
 *
 * @param {string} repo The repository identifier in the format
 * 'owner/repository_name' (e.g., "semantic-release/semantic-release").
 * @param {string | undefined} githubToken Optional GitHub Personal Access
 * Token. This token should have the 'repo' scope for accessing private
 * repositories or for making authenticated requests to public repositories
 * to avoid stricter rate limits.
 *
 * @returns {Promise<string>} A Promise that resolves to the highest (most
 * recent) semver-valid tag name as a string if one or more suitable tags
 * are found among the repository's releases.
 * @throws {SemanticReleaseError} This error is thrown under various
 * conditions:
 * - If there's a network issue while attempting to fetch releases.
 * - If the GitHub API returns an HTTP error status (e.g., 401 Unauthorized,
 * 403 Forbidden, 404 Not Found). The error message will provide context
 * based on the status code and whether a token was provided.
 * - If the response from the GitHub API is not in the expected format (e.g.,
 * not an array, or array items lacking 'tag_name' strings).
 * - If no valid semver release tags are found among the latest 100 releases
 * for the specified repository.
 */
const getLatestSemverTag = async (
  repo: string,
  githubToken: string | undefined,
): Promise<string> => {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(githubToken && { Authorization: `Bearer ${githubToken}` }),
  };

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SemanticReleaseError(
      `Network error while attempting to fetch releases from ${repo}: ${message}`,
    );
  }

  if (!response.ok) {
    const errorStatus = response.status;
    const statusText = response.statusText;
    const errorPrefix = `Failed to fetch releases from ${repo} (${errorStatus} ${statusText}).`;

    switch (errorStatus) {
      case 404: {
        const specificMessage = githubToken
          ? `Repository not found, or the provided GitHub token does not have 'repo' scope access to it.`
          : `The repository was not found or it is private. For private repositories, please provide a GitHub token with 'repo' scope.`;
        throw new SemanticReleaseError(`${errorPrefix} ${specificMessage}`);
      }
      case 401: {
        const specificMessage = `Authentication failed. The provided GitHub token is likely invalid, expired, or does not have the 'repo' scope.`;
        throw new SemanticReleaseError(`${errorPrefix} ${specificMessage}`);
      }
      case 403: {
        const specificMessage = `Access forbidden. The provided GitHub token might lack required scopes (e.g., 'repo'), or an API rate limit was exceeded. Check token scopes and GitHub's rate limit documentation.`;
        throw new SemanticReleaseError(`${errorPrefix} ${specificMessage}`);
      }
      default: {
        const specificMessage = `Please check repository URL, token permissions, and GitHub status page.`;
        throw new SemanticReleaseError(`${errorPrefix} ${specificMessage}`);
      }
    }
  } else {
    const releasesPayload: unknown = await response.json();

    if (
      !Array.isArray(releasesPayload) ||
      !releasesPayload.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'tag_name' in item &&
          typeof (item as { tag_name: unknown }).tag_name === 'string',
      )
    ) {
      throw new SemanticReleaseError(
        `Invalid response format received from GitHub API when fetching releases for ${repo}. Expected an array of objects with 'tag_name' strings.`,
      );
    } else {
      return (() => {
        const sortedTags = sortSemverTags(
          (releasesPayload as Array<{ tag_name: string }>).map(
            (r) => r.tag_name,
          ),
        );

        if (sortedTags.length > 0) {
          return sortedTags[0];
        } else {
          throw new SemanticReleaseError(
            `No valid semver release tags found among the latest 100 releases for ${repo}. Unable to determine the latest version.`,
          );
        }
      })();
    }
  }
};

/**
 * This hook is part of the semantic-release lifecycle and is responsible for
 * verifying that all necessary conditions are met before the release process
 * proceeds. Specifically, this function focuses on determining and storing the
 * major version cap from an "upstream" repository.
 *
 * It fetches the latest semantic version tag from the repository specified in
 * `pluginConfig.repo`. The `pluginConfig.githubToken` can be used for
 * authentication if the upstream repository is private or to avoid API rate
 * limits when interacting with GitHub.
 *
 * Once the latest tag is retrieved (using the `getLatestSemverTag` helper
 * function):
 * 1. If a valid semantic version tag is found, its major version component is
 * extracted (e.g., for tag "v3.4.5", the major version is 3).
 * 2. This major version number is then stored in the `context` object as
 * `context.majorCapFromUpstream`. This allows other plugin hooks within the
 * same semantic-release execution to access this pre-calculated cap.
 * 3. If no valid semantic version tags are found in the upstream repository,
 * the `context.majorCapFromUpstream` is set to 0.
 *
 * A critical configuration is `pluginConfig.repo`, which specifies the
 * upstream repository (e.g., "owner/repo"). If this configuration is
 * missing, the function will throw a `SemanticReleaseError`, halting the
 * release process as the cap cannot be determined.
 *
 * @param {object} pluginConfig - The plugin configuration object.
 * @param {string} pluginConfig.repo - The identifier of the upstream
 * repository (e.g., "owner/repo") from which to fetch the latest tag for
 * determining the major version cap. This is a required configuration.
 * @param {string} [pluginConfig.githubToken] - An optional GitHub token for
 * accessing the upstream repository.
 * @param {object} context - The semantic-release context object. This object
 * will be augmented with the `majorCapFromUpstream` property.
 * @param {BaseContext['logger']} context.logger - The logger instance for logging messages.
 * @param {number} [context.majorCapFromUpstream] - This property will be added
 * or updated by this function to store the determined upstream major version cap.
 *
 * @returns {Promise<void>} A Promise that resolves if all conditions are met
 * and the upstream major cap is successfully determined and stored.
 * @throws {SemanticReleaseError} If the required `pluginConfig.repo` is not
 * provided.
 */
export async function verifyConditions(
  pluginConfig: PluginConfig,
  context: VerifyConditionsContext & { majorCapFromUpstream: number },
): Promise<void> {
  const { repo, githubToken } = pluginConfig;

  if (!repo) {
    throw new SemanticReleaseError('Missing required config "repo".');
  } else {
    context.logger.log(`Checking latest semver tag in ${repo}…`);
    const latestTag = await getLatestSemverTag(repo, githubToken);
    if (latestTag !== null) {
      const cap = semver.major(latestTag);
      context.majorCapFromUpstream = cap;
      context.logger.log(`Latest tag is "${latestTag}" → major cap = ${cap}.`);
    } else {
      context.majorCapFromUpstream = 0;
      context.logger.log('No valid tags found → major cap = 0.');
    }
  }
}

/**
 * Determines the type of release (e.g., 'major', 'minor', 'patch', or null)
 * based on the analyzed commit messages since the last release. This function
 * extends the standard commit analysis by introducing a crucial feature: it
 * can block a 'major' release if the resulting new major version
 * exceeds the major version of the latest release found in a specified
 * "upstream" repository.
 *
 * The function first delegates the core commit analysis to an underlying
 * commit analyzer module. It uses
 * the `pluginConfig.commitAnalyzerConfig` to configure this base analyzer. If
 * no specific configuration is provided, it defaults to using the
 * "conventionalcommits" preset for determining the release type.
 *
 * If the underlying analyzer determines that the release type is 'major',
 * this function then performs the upstream cap check:
 * 1. It retrieves the latest semantic version tag from the upstream
 * repository specified by `pluginConfig.repo`, using the
 * `pluginConfig.githubToken` for authentication if necessary. This is
 * achieved via the `getLatestSemverTag` helper function.
 * 2. The major component of this upstream tag (or 0 if no tags are found)
 * establishes the "major version cap".
 * 3. It calculates the next potential major version for the current project
 * based on `context.lastRelease.version`.
 * 4. If this calculated next major version is greater than the upstream
 * major version cap, a `SemanticReleaseError` is thrown, halting the
 * release process and preventing an excessive major version bump.
 * 5. Otherwise, the 'major' release is allowed to proceed.
 *
 * If the release type determined by the base analyzer is not 'major' (e.g.,
 * 'minor', 'patch', or null), the upstream cap check is skipped, and the
 * function simply returns the determined release type.
 *
 * @param {object} pluginConfig - The plugin configuration object.
 * @param {string} pluginConfig.repo - The identifier of the upstream
 * repository (e.g., "owner/repo") used to determine the major version cap.
 * @param {string} [pluginConfig.githubToken] - An optional GitHub token for
 * accessing the upstream repository if it's private or to avoid rate limits.
 * @param {object} [pluginConfig.commitAnalyzerConfig] - Optional configuration
 * for the underlying commit analyzer. If not provided, defaults to
 * `{ preset: "conventionalcommits" }`.
 * @param {object} context - The semantic-release context object.
 * @param {object} context.lastRelease - Information about the last release.
 * @param {string} [context.lastRelease.version] - The version of the last
 * release (e.g., "1.2.3"). Defaults to "0.0.0" if no last release.
 * @param {BaseContext['logger']} context.logger - The logger instance for logging messages.
 *
 * @returns {Promise<string|null>} A Promise that resolves to the determined
 * release type ('major', 'minor', 'patch') or null if no release is
 * warranted.
 * @throws {SemanticReleaseError} If a 'major' release is detected and the
 * next major version would exceed the major version cap derived from the
 * upstream repository.
 */
export async function analyzeCommits(
  pluginConfig: PluginConfig & { commitAnalyzerConfig?: unknown },
  context: AnalyzeCommitsContext,
): Promise<string | null> {
  let effectiveCommitAnalyzerConfig = pluginConfig.commitAnalyzerConfig;
  if (
    !effectiveCommitAnalyzerConfig ||
    Object.keys(effectiveCommitAnalyzerConfig).length === 0
  ) {
    context.logger.log(
      'No specific commitAnalyzerConfig provided, defaulting to { preset: "conventionalcommits" } for base analyzer.',
    );
    const conventionalCommitsPresetPath =
      require.resolve('conventional-changelog-conventionalcommits');
    effectiveCommitAnalyzerConfig = {
      config: conventionalCommitsPresetPath,
    };
  } else {
    context.logger.log(
      'Using provided commitAnalyzerConfig for base analyzer.',
    );
  }
  const releaseType = await commitAnalyser(
    effectiveCommitAnalyzerConfig,
    context,
  );

  if (releaseType === 'major') {
    const { repo, githubToken } = pluginConfig;
    let cap: number;

    context.logger.log(
      `Determining major version cap from upstream releases for ${repo} (in analyzeCommits).`,
    );
    const latestTag = await getLatestSemverTag(repo, githubToken);

    if (latestTag !== null) {
      cap = semver.major(latestTag);
      context.logger.log(
        `Latest upstream release tag is "${latestTag}" → upstream major cap = ${cap}.`,
      );
    } else {
      cap = 0;
      context.logger.log(
        `No valid upstream release tags found → upstream major cap = 0.`,
      );
    }

    const current = context.lastRelease?.version ?? '0.0.0';
    const next = semver.inc(current, 'major');
    if (next !== null) {
      const nextMaj = semver.major(next);
      if (nextMaj > cap) {
        throw new SemanticReleaseError(
          `Blocked: next major version ${nextMaj} would exceed upstream major version cap of ${cap} (derived from upstream repo: ${pluginConfig.repo}).`,
        );
      } else {
        context.logger.log(
          `Next major version ${nextMaj} is within or equal to upstream major version cap ${cap}; proceeding.`,
        );
      }
    } else {
      context.logger.log(
        'Could not compute next major version; skipping cap check.',
      );
    }
  } else {
    context.logger.log(
      `Release type is "${releaseType}" — no major bump, cap check not applicable.`,
    );
  }

  return releaseType;
}
