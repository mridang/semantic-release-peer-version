import semver from 'semver';
// @ts-expect-error dgd fgsgs
import { analyzeCommits as moox } from '@semantic-release/commit-analyzer';
import {
  AnalyzeCommitsContext,
  BaseContext,
  VerifyConditionsContext,
} from 'semantic-release';

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
 * Fetches the highest semver-valid tag from the GitHub releases of the specified repository.
 * It considers up to the last 100 releases and returns the tag with the highest semantic version.
 *
 * @param repo The repository identifier in the format 'owner/repository_name'.
 * @param githubToken Optional GitHub token for accessing private repositories or avoiding rate limits.
 * @param logger A logger instance for logging informational messages.
 * @returns A Promise that resolves to the highest semver tag name as a string, or null if no suitable tag is found.
 */
const getLatestSemverTag = async (
  repo: string,
  githubToken: string | undefined,
  logger: BaseContext['logger'],
): Promise<string | null> => {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[block-major] Network error fetching releases: ${message}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `[block-major] Failed to fetch releases from ${repo}: ${response.status} ${response.statusText}`,
    );
  } else {
    const releases: Array<{ tag_name: string }> =
      (await response.json()) as Array<{
        tag_name: string;
      }>;
    const sortedSemverReleaseTags = sortSemverTags(
      releases.map((r) => r.tag_name),
    );

    if (sortedSemverReleaseTags.length > 0) {
      return sortedSemverReleaseTags[0];
    }

    logger.log(`[block-major] No valid semver release tags found for ${repo}.`);
    return null;
  }
};

/**
 * verifyConditions hook
 * Fetches and stores the upstream major version cap.
 */
export async function verifyConditions(
  pluginConfig: PluginConfig,
  context: VerifyConditionsContext & { majorCapFromUpstream: number },
): Promise<void> {
  const { repo, githubToken } = pluginConfig;

  if (!repo) {
    throw new Error('[block-major] Missing required config "repo".');
  } else {
    context.logger.log(`[block-major] Checking latest semver tag in ${repo}…`);
    const latestTag = await getLatestSemverTag(
      repo,
      githubToken,
      context.logger,
    );
    if (latestTag !== null) {
      const cap = semver.major(latestTag);
      context.majorCapFromUpstream = cap;
      context.logger.log(
        `[block-major] Latest tag is "${latestTag}" → major cap = ${cap}.`,
      );
    } else {
      context.majorCapFromUpstream = 0;
      context.logger.log('[block-major] No valid tags found → major cap = 0.');
    }
  }
}

/**
 * analyzeCommits hook
 * Blocks a major release if it exceeds the upstream cap.
 */
/**
 * analyzeCommits hook
 * Blocks a major release if it exceeds the upstream cap.
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
      '[block-major] No specific commitAnalyzerConfig provided, defaulting to { preset: "conventionalcommits" } for base analyzer.',
    );
    effectiveCommitAnalyzerConfig = { preset: 'conventionalcommits' };
  } else {
    context.logger.log(
      '[block-major] Using provided commitAnalyzerConfig for base analyzer.',
    );
  }
  const releaseType = await moox(effectiveCommitAnalyzerConfig, context);

  if (releaseType === 'major') {
    const { repo, githubToken } = pluginConfig;
    let cap: number;

    context.logger.log(
      `[block-major] Determining major version cap from upstream releases for ${repo} (in analyzeCommits).`,
    );
    const latestTag = await getLatestSemverTag(
      repo,
      githubToken,
      context.logger,
    );

    if (latestTag !== null) {
      cap = semver.major(latestTag);
      context.logger.log(
        `[block-major] Latest upstream release tag is "${latestTag}" → upstream major cap = ${cap}.`,
      );
    } else {
      cap = 0;
      context.logger.log(
        `[block-major] No valid upstream release tags found → upstream major cap = 0.`,
      );
    }

    const current = context.lastRelease?.version ?? '0.0.0';
    const next = semver.inc(current, 'major');
    if (next !== null) {
      const nextMaj = semver.major(next);
      if (nextMaj > cap) {
        throw new Error(
          `[block-major] Blocked: next major version ${nextMaj} would exceed upstream major version cap of ${cap} (derived from upstream repo: ${pluginConfig.repo}).`,
        );
      } else {
        context.logger.log(
          `[block-major] Next major version ${nextMaj} is within or equal to upstream major version cap ${cap}; proceeding.`,
        );
      }
    } else {
      context.logger.log(
        '[block-major] Could not compute next major version; skipping cap check.',
      );
    }
  } else {
    context.logger.log(
      `[block-major] Release type is "${releaseType}" — no major bump, cap check not applicable.`,
    );
  }

  return releaseType;
}
