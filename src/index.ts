/**
 * @file The semantic-release plugin that caps a major release at the upstream major version.
 */

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
  assertRepo,
  customCommitAnalyzerConfig,
  type PluginConfig,
} from './plugin-config.js';

export type { PluginConfig } from './plugin-config.js';

const require = createRequire(import.meta.url);

/* eslint-disable jsdoc/check-tag-names -- @rejects is the tag jsdoc/require-rejects asks for, which check-tag-names does not list */

/**
 * Fetches up to the last 100 releases of the repository and returns the tag
 * of the highest semantic version among them (for example "v1.2.3" or
 * "1.3.0-beta.1"). Tags that are not valid semver are ignored.
 * @param config - The plugin configuration.
 * @returns The highest semver-valid release tag.
 * @rejects {SemanticReleaseError} If the releases cannot be fetched or read
 * (see {@link GitHubClient.listReleaseTags}), or none of the latest 100
 * releases has a valid semver tag.
 * @example
 * ```ts
 * const tag = await getLatestSemverTag({ repo: 'cli/cli' }); // e.g. 'v2.40.0'
 * ```
 */
async function getLatestSemverTag(config: PluginConfig): Promise<string> {
  const tags = await new GitHubClient({
    token: config.githubToken,
  }).listReleaseTags(config.repo);
  const latest = tags
    .filter((tag) => semver.valid(tag) !== null)
    .toSorted(semver.rcompare)
    .at(0);
  if (latest === undefined) {
    throw new SemanticReleaseError(
      `No valid semver release tags found among the latest 100 releases for ${config.repo}. Unable to determine the latest version.`,
    );
  }
  return latest;
}
/* eslint-enable jsdoc/check-tag-names -- end of the @rejects exception */

/**
 * Semantic-release `verifyConditions` step. Finds the latest semantic version
 * tag in the upstream repository `config.repo`, so that a release fails early
 * when GitHub cannot be reached or the repository has no semver release. Its
 * major version is the cap that `analyzeCommits` enforces.
 * The `githubToken` is only needed for private repositories or to avoid rate
 * limits.
 * @param config - The plugin configuration.
 * @param context - The semantic-release context.
 * @throws {SemanticReleaseError} If `repo` is not configured, or the latest
 * tag cannot be determined.
 * @example
 * ```ts
 * await verifyConditions({ repo: 'cli/cli' }, context); // logs the major cap
 * ```
 */
export async function verifyConditions(
  config: PluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  assertRepo(config.repo);
  context.logger.log(`Checking latest semver tag in ${config.repo}…`);
  const latestTag = await getLatestSemverTag(config);
  const cap = semver.major(latestTag);
  context.logger.log(`Latest tag is "${latestTag}" → major cap = ${cap}.`);
}

/**
 * The configuration for the underlying commit analyzer: the user's own, or the
 * `conventionalcommits` preset when none was given.
 * @param config - The plugin configuration.
 * @param logger - The semantic-release logger.
 * @returns The configuration to hand to the commit analyzer.
 * @example
 * ```ts
 * analyzerConfigOf({ repo: 'o/r' }, context.logger); // { config: '<conventionalcommits preset>' }
 * ```
 */
function analyzerConfigOf(
  config: PluginConfig,
  logger: BaseContext['logger'],
): NonNullable<unknown> {
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

/* eslint-disable jsdoc/check-tag-names -- @rejects is the tag jsdoc/require-rejects asks for, which check-tag-names does not list */

/**
 * Semantic-release `analyzeCommits` step. Delegates to the standard commit
 * analyzer, then blocks a `major` release whose new major version would exceed
 * the major version of the latest release in the upstream repository
 * `config.repo`. Any other release type is returned untouched.
 * @param config - The plugin configuration.
 * @param context - The semantic-release context.
 * @returns The release type (`major`, `minor`, `patch`), or null when no
 * release is warranted.
 * @rejects {SemanticReleaseError} If the next major version would exceed the
 * upstream major version, or the upstream cap cannot be determined.
 * @example
 * ```ts
 * const releaseType = await analyzeCommits({ repo: 'cli/cli' }, context); // 'minor'
 * ```
 */
export async function analyzeCommits(
  config: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<string | null> {
  assertRepo(config.repo);
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
/* eslint-enable jsdoc/check-tag-names -- end of the @rejects exception */

export default { verifyConditions, analyzeCommits } as const;
