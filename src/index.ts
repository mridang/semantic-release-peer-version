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
   * Git branch to check tags against (e.g. "main" or "release").
   */
  branch: string;

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
 * Check whether a given tag name is reachable from the branch head.
 *
 * Uses the GitHub compare API: base = tag, head = branch.
 *
 * @param repo - "owner/repo"
 * @param tagName
 * @param branch
 * @param githubToken
 * @param logger
 * @returns true if branch HEAD is descendant or identical to tag commit
 */
const isTagOnBranch = async (
  repo: string,
  tagName: string,
  branch: string,
  githubToken: string | undefined,
  logger: BaseContext['logger'],
): Promise<boolean> => {
  const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(tagName)}...${encodeURIComponent(branch)}`;
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
      `[block-major] Network error comparing ${tagName} to ${branch}: ${message}`,
    );
  }

  if (!response.ok) {
    logger.log(
      `[block-major] Compare API returned ${response.status} for ${tagName}… skipping.`,
    );
    return false;
  } else {
    const body = (await response.json()) as { status: string };
    const status: string = body.status;
    const ok = status === 'ahead' || status === 'identical';
    logger.log(
      `[block-major] compare ${tagName}→${branch}: status="${status}" → ${ok ? 'included' : 'excluded'}`,
    );
    return ok;
  }
};

/**
 * Fetch the latest semver-valid tag that lives on the given branch.
 *
 * @param repo
 * @param branch
 * @param githubToken
 * @param logger
 * @returns tag name or null if none found
 */
const getLatestSemverTag = async (
  repo: string,
  branch: string,
  githubToken: string | undefined,
  logger: BaseContext['logger'],
): Promise<string | null> => {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
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
    throw new Error(`[block-major] Network error fetching tags: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      `[block-major] Failed to fetch tags from ${repo}: ${response.status} ${response.statusText}`,
    );
  } else {
    const tags: Array<{ name: string }> = (await response.json()) as Array<{
      name: string;
    }>;
    const candidates = sortSemverTags(tags.map((t) => t.name));

    for (const tag of candidates) {
      /* eslint-disable no-await-in-loop */
      if (await isTagOnBranch(repo, tag, branch, githubToken, logger)) {
        return tag;
      }
      /* eslint-enable no-await-in-loop */
    }

    logger.log(`[block-major] No semver tags on branch ${branch}.`);
    return null;
  }
};

// noinspection JSUnusedGlobalSymbols
/**
 * verifyConditions hook
 * Fetches and stores the upstream major version cap.
 */
export async function verifyConditions(
  pluginConfig: PluginConfig,
  context: VerifyConditionsContext & { majorCapFromUpstream: number },
): Promise<void> {
  const { repo, branch, githubToken } = pluginConfig;

  if (!repo || !branch) {
    throw new Error(
      '[block-major] Missing required config "repo" or "branch".',
    );
  } else {
    context.logger.log(
      `[block-major] Checking latest semver tag in ${repo}@${branch}…`,
    );
    const latestTag = await getLatestSemverTag(
      repo,
      branch,
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

// noinspection JSUnusedGlobalSymbols
/**
 * analyzeCommits hook
 * Blocks a major release if it exceeds the upstream cap.
 */
export async function analyzeCommits(
  pluginConfig: PluginConfig & { commitAnalyzerConfig?: unknown },
  context: AnalyzeCommitsContext & { majorCapFromUpstream: number },
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
    const current = context.lastRelease?.version ?? '0.0.0';
    const next = semver.inc(current, 'major');
    if (next !== null) {
      const nextMaj = semver.major(next);
      const cap = context.majorCapFromUpstream ?? Infinity;
      if (nextMaj > cap) {
        throw new Error(
          `[block-major] Blocked: next major ${nextMaj} > cap ${cap} (from ${pluginConfig.repo}@${pluginConfig.branch}).`,
        );
      } else {
        context.logger.log(
          `[block-major] Next major ${nextMaj} is within cap ${cap}; proceeding.`,
        );
      }
    } else {
      context.logger.log(
        '[block-major] Could not compute next version; skipping cap check.',
      );
    }
  } else {
    context.logger.log(
      `[block-major] Release type "${releaseType}" — no major bump.`,
    );
  }

  return releaseType;
}
