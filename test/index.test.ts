import { afterEach, describe, expect, it, jest } from '@jest/globals';
import semver from 'semver';
import { isRecord, stringAt } from '../src/utils/object.js';
// noinspection ES6PreferShortImport
import plugin, { analyzeCommits, verifyConditions } from '../src/index.js';
import { GitHubClient } from '../src/github.js';
import { commit, stepContext, type AnalyzeContext } from './utils/context.js';
import type { VerifyConditionsContext } from 'semantic-release';

jest.setTimeout(30_000);

afterEach(() => {
  jest.restoreAllMocks();
});

const token = process.env['GITHUB_TOKEN'];

/**
 * How many more requests GitHub will accept from this machine. The rate limit
 * endpoint is not itself counted.
 * @returns The remaining requests, or 0 when it cannot be read.
 */
const remainingRequests = async (): Promise<number> => {
  const response = await fetch('https://api.github.com/rate_limit', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => undefined);
  const body: unknown = await response?.json().catch(() => undefined);
  const resources = isRecord(body) ? body['resources'] : undefined;
  const core = isRecord(resources) ? resources['core'] : undefined;
  const remaining = isRecord(core) ? core['remaining'] : undefined;
  return typeof remaining === 'number' ? remaining : 0;
};

// The real-API tests would only fail on a spent rate limit, so skip them then.
const remaining = await remainingRequests();
if (remaining < 10) {
  console.warn(
    `Skipping the real-API tests: GitHub allows only ${remaining} more requests (set GITHUB_TOKEN to raise the limit) or could not be reached.`,
  );
}
const integration = remaining >= 10 ? describe : describe.skip;

integration('Integration: block-major plugin hooks', () => {
  it('verifyConditions() reads the real latest semver tag', async () => {
    const { context, lines } = stepContext<VerifyConditionsContext>();

    await verifyConditions({ repo: 'cli/cli', githubToken: token }, context);
    const res = await fetch(
      `https://api.github.com/repos/cli/cli/tags?per_page=1`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    const tags: unknown = await res.json();
    const name =
      Array.isArray(tags) && isRecord(tags[0])
        ? stringAt(tags[0], 'name')
        : undefined;
    expect(name).toBeDefined();
    expect(lines.join('\n')).toContain(
      `major cap = ${semver.major(name ?? '')}.`,
    );
  });

  it('analyzeCommits() yields "major" for a breaking change when under cap', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '1.2.3' },
      commits: [commit('feat!: this is breaking')],
    });

    expect(
      await analyzeCommits({ repo: 'cli/cli', githubToken: token }, context),
    ).toBe('major');
  });

  it('analyzeCommits() blocks a major bump if cap is too low', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '2.0.0' },
      commits: [commit('feat!: another break')],
    });

    await expect(
      analyzeCommits({ repo: 'cli/cli', githubToken: token }, context),
    ).rejects.toThrow(/Blocked: next major/);
  });

  it('analyzeCommits() passes through non-major bump', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '3.0.0' },
      commits: [commit('fix: update README')],
    });

    expect(
      await analyzeCommits({ repo: 'cli/cli', githubToken: token }, context),
    ).toBe('patch');
  });
});

describe('plugin steps with the GitHub client stubbed', () => {
  const upstream = (tags: readonly string[]) =>
    jest
      .spyOn(GitHubClient.prototype, 'listReleaseTags')
      .mockResolvedValue(tags);

  it('exports the steps as the default export', () => {
    expect(plugin).toEqual({ verifyConditions, analyzeCommits });
  });

  describe('verifyConditions', () => {
    const make = () => stepContext<VerifyConditionsContext>();

    it('requires a repo', async () => {
      const { context } = make();

      await expect(verifyConditions({ repo: '' }, context)).rejects.toThrow(
        'Missing required config "repo".',
      );
    });

    it('refuses a repo that is not owner/name', async () => {
      await expect(
        verifyConditions({ repo: 'o/r?x=1' }, make().context),
      ).rejects.toMatchObject({ code: 'EINVALIDREPO' });
    });

    it('takes the major of the highest semver tag, ignoring other tags', async () => {
      const list = upstream(['v1.2.0', 'latest', 'v3.1.0', 'v2.0.0']);
      const { context, lines } = make();

      await verifyConditions({ repo: 'o/r', githubToken: 'T' }, context);

      expect(list).toHaveBeenCalledWith('o/r');
      expect(lines).toContain('Latest tag is "v3.1.0" → major cap = 3.');
    });

    it('fails when no release has a semver tag', async () => {
      upstream(['latest', 'nightly']);
      const { context } = make();

      await expect(verifyConditions({ repo: 'o/r' }, context)).rejects.toThrow(
        'No valid semver release tags found among the latest 100 releases for o/r. Unable to determine the latest version.',
      );
    });

    it('fails when there are no releases at all', async () => {
      upstream([]);

      await expect(
        verifyConditions({ repo: 'o/r' }, make().context),
      ).rejects.toThrow(/No valid semver release tags/);
    });
  });

  describe('analyzeCommits', () => {
    const make = (header: string, lastRelease: object = { version: '1.0.0' }) =>
      stepContext<AnalyzeContext>({ lastRelease, commits: [commit(header)] });

    it('requires a valid repo even when no major bump is checked', async () => {
      const { context } = make('chore: tidy');

      await expect(analyzeCommits({ repo: '' }, context)).rejects.toThrow(
        'Missing required config "repo".',
      );
      await expect(
        analyzeCommits({ repo: 'o/r/../x' }, context),
      ).rejects.toMatchObject({ code: 'EINVALIDREPO' });
    });

    it('returns null without calling GitHub when there is nothing to release', async () => {
      const list = upstream(['v1.0.0']);
      const { context, lines } = make('chore: tidy');

      expect(await analyzeCommits({ repo: 'o/r' }, context)).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(lines).toContain(
        'Release type is "null" — no major bump, cap check not applicable.',
      );
    });

    it('does not call GitHub for a minor bump', async () => {
      const list = upstream(['v1.0.0']);

      expect(
        await analyzeCommits({ repo: 'o/r' }, make('feat: add').context),
      ).toBe('minor');
      expect(list).not.toHaveBeenCalled();
    });

    it('allows a major bump up to the upstream major', async () => {
      upstream(['v2.4.0', 'v1.0.0']);
      const { context, lines } = make('feat!: break');

      expect(await analyzeCommits({ repo: 'o/r' }, context)).toBe('major');
      expect(lines).toContain(
        'Next major version 2 is within or equal to upstream major version cap 2; proceeding.',
      );
    });

    it('blocks a major bump beyond the upstream major', async () => {
      upstream(['v1.9.0']);

      await expect(
        analyzeCommits({ repo: 'o/r' }, make('feat!: break').context),
      ).rejects.toThrow(
        'Blocked: next major version 2 would exceed upstream major version cap of 1 (derived from upstream repo: o/r).',
      );
    });

    it('treats a missing last release as 0.0.0', async () => {
      upstream(['v1.0.0']);

      expect(
        await analyzeCommits({ repo: 'o/r' }, make('feat!: break', {}).context),
      ).toBe('major');
    });

    it('skips the cap check when the next major cannot be computed', async () => {
      upstream(['v1.0.0']);
      const { context, lines } = make('feat!: break', { version: 'garbage' });

      expect(await analyzeCommits({ repo: 'o/r' }, context)).toBe('major');
      expect(lines).toContain(
        'Could not compute next major version; skipping cap check.',
      );
    });

    it('analyses with the commit analyzer configuration it is given', async () => {
      const list = upstream(['v9.0.0']);
      const { context, lines } = make('feat!: brk');

      // The angular preset does not read `!` as a breaking change.
      const result = await analyzeCommits(
        { repo: 'o/r', commitAnalyzerConfig: { preset: 'angular' } },
        context,
      );

      expect(result).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(lines).toContain(
        'Using provided commitAnalyzerConfig for base analyzer.',
      );
    });

    it('passes a configuration that is not an object on, as before', async () => {
      const list = upstream(['v9.0.0']);
      const { context, lines } = make('feat!: brk');

      // The analyzer ignores a string and uses its own angular default.
      const result = await analyzeCommits(
        { repo: 'o/r', commitAnalyzerConfig: 'angular' },
        context,
      );

      expect(result).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(lines).toContain(
        'Using provided commitAnalyzerConfig for base analyzer.',
      );
    });

    it.each([undefined, {}, null])(
      'defaults to the conventionalcommits preset for %p',
      async (commitAnalyzerConfig) => {
        upstream(['v9.0.0']);
        const { context, lines } = make('feat!: brk');

        // The conventionalcommits preset reads `!` as a breaking change.
        const result = await analyzeCommits(
          { repo: 'o/r', commitAnalyzerConfig },
          context,
        );

        expect(result).toBe('major');
        expect(lines[0]).toMatch(
          /defaulting to \{ preset: "conventionalcommits" \}/,
        );
      },
    );
  });
});
