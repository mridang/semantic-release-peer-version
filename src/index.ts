import { createRequire } from 'node:module';
import SemanticReleaseError from '@semantic-release/error';
import { analyzeCommits as commitAnalyser } from '@semantic-release/commit-analyzer';
import semver from 'semver';
import type {
  AnalyzeCommitsContext,
  BaseContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { GitHubClient } from './github.js';
import {
  customCommitAnalyzerConfig,
  type PluginConfig,
} from './plugin-config.js';

export type { PluginConfig } from './plugin-config.js';

const require = createRequire(import.meta.url);

/**
 * The context of the steps of this plugin. `majorCapFromUpstream` is written
 * by `verifyConditions` so that later steps of the same run can read it.
 */
type CapContext = { majorCapFromUpstream?: number };

/**
 * Fetches up to the last 100 releases of the repository and returns the tag
 * of the highest semantic version among them (for example "v1.2.3" or
 * "1.3.0-beta.1"). Tags that are not valid semver are ignored.
 *
 * @param config The plugin configuration.
 * @returns The highest semver-valid release tag.
 * @throws {SemanticReleaseError} If the releases cannot be fetched or read
 * (see {@link GitHubClient.listReleaseTags}), or none of the latest 100
 * releases has a valid semver tag.
 */
async function getLatestSemverTag(config: PluginConfig): Promise<string> {
  const tags = await new GitHubClient({
    token: config.githubToken,
  }).listReleaseTags(config.repo);
  const [latest] = tags
    .filter((tag) => semver.valid(tag) !== null)
    .toSorted(semver.rcompare);
  if (latest === undefined) {
    throw new SemanticReleaseError(
      `No valid semver release tags found among the latest 100 releases for ${config.repo}. Unable to determine the latest version.`,
    );
  }
  return latest;
}

/**
 * semantic-release `verifyConditions` step. Finds the latest semantic version
 * tag in the upstream repository `config.repo` and stores its major version as
 * `context.majorCapFromUpstream`, so other steps of the same run can read it.
 * The `githubToken` is only needed for private repositories or to avoid rate
 * limits.
 *
 * @param config The plugin configuration.
 * @param context The semantic-release context, which is given the cap.
 * @throws {SemanticReleaseError} If `repo` is not configured, or the latest
 * tag cannot be determined.
 */
export async function verifyConditions(
  config: PluginConfig,
  context: VerifyConditionsContext & CapContext,
): Promise<void> {
  if (!config.repo) {
    throw new SemanticReleaseError('Missing required config "repo".');
  }
  context.logger.log(`Checking latest semver tag in ${config.repo}…`);
  const latestTag = await getLatestSemverTag(config);
  const cap = semver.major(latestTag);
  // Kept from the original plugin. semantic-release gives every step its own
  // copy of the context, so other steps do not see this value; `analyzeCommits`
  // looks the cap up again.
  context.majorCapFromUpstream = cap;
  context.logger.log(`Latest tag is "${latestTag}" → major cap = ${cap}.`);
}

/**
 * The configuration for the underlying commit analyzer: the user's own, or the
 * `conventionalcommits` preset when none was given.
 *
 * @param config The plugin configuration.
 * @param logger The semantic-release logger.
 * @returns The configuration to hand to the commit analyzer.
 */
function analyzerConfigOf(
  config: PluginConfig,
  logger: BaseContext['logger'],
): Readonly<Record<string, unknown>> {
  const custom = customCommitAnalyzerConfig(config);
  if (custom !== undefined) {
    logger.log('Using provided commitAnalyzerConfig for base analyzer.');
    return custom;
  }
  logger.log(
    'No specific commitAnalyzerConfig provided, defaulting to { preset: "conventionalcommits" } for base analyzer.',
  );
  return {
    config: require.resolve('conventional-changelog-conventionalcommits'),
  };
}

/**
 * semantic-release `analyzeCommits` step. Delegates to the standard commit
 * analyzer, then blocks a `major` release whose new major version would exceed
 * the major version of the latest release in the upstream repository
 * `config.repo`. Any other release type is returned untouched.
 *
 * @param config The plugin configuration.
 * @param context The semantic-release context.
 * @returns The release type (`major`, `minor`, `patch`), or null when no
 * release is warranted.
 * @throws {SemanticReleaseError} If the next major version would exceed the
 * upstream major version, or the upstream cap cannot be determined.
 */
export async function analyzeCommits(
  config: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<string | null> {
  const releaseType = await commitAnalyser(
    analyzerConfigOf(config, context.logger),
    context,
  );

  if (releaseType !== 'major') {
    context.logger.log(
      `Release type is "${releaseType}" — no major bump, cap check not applicable.`,
    );
    return releaseType;
  }

  context.logger.log(
    `Determining major version cap from upstream releases for ${config.repo} (in analyzeCommits).`,
  );
  const latestTag = await getLatestSemverTag(config);
  const cap = semver.major(latestTag);
  context.logger.log(
    `Latest upstream release tag is "${latestTag}" → upstream major cap = ${cap}.`,
  );

  const next = semver.inc(context.lastRelease?.version ?? '0.0.0', 'major');
  if (next === null) {
    context.logger.log(
      'Could not compute next major version; skipping cap check.',
    );
    return releaseType;
  }
  const nextMajor = semver.major(next);
  if (nextMajor > cap) {
    throw new SemanticReleaseError(
      `Blocked: next major version ${nextMajor} would exceed upstream major version cap of ${cap} (derived from upstream repo: ${config.repo}).`,
    );
  }
  context.logger.log(
    `Next major version ${nextMajor} is within or equal to upstream major version cap ${cap}; proceeding.`,
  );
  return releaseType;
}

export default { verifyConditions, analyzeCommits } as const;
