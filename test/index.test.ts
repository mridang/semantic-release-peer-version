import { afterEach, describe, expect, it, jest } from '@jest/globals';
import semver from 'semver';
import { isRecord, stringAt } from '../src/utils/object.js';
// noinspection ES6PreferShortImport
import plugin, { analyzeCommits, verifyConditions } from '../src/index.js';
import { GitHubClient } from '../src/github.js';
import { commit, stepContext, type AnalyzeContext } from './utils/context.js';
import type { VerifyConditionsContext } from 'semantic-release';

jest.setTimeout(30000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Integration: block-major plugin hooks', () => {
  it('verifyConditions() reads the real latest semver tag', async () => {
    const { context } = stepContext<
      VerifyConditionsContext & { majorCapFromUpstream?: number }
    >();

    await verifyConditions({ repo: 'cli/cli' }, context);
    expect(typeof context.majorCapFromUpstream).toBe('number');
    expect(context.majorCapFromUpstream).toBeGreaterThanOrEqual(0);
    const res = await fetch(
      `https://api.github.com/repos/cli/cli/tags?per_page=1`,
    );
    const tags: unknown = await res.json();
    const name =
      Array.isArray(tags) && isRecord(tags[0])
        ? stringAt(tags[0], 'name')
        : undefined;
    expect(name).toBeDefined();
    expect(context.majorCapFromUpstream).toBe(semver.major(name ?? ''));
  });

  it('analyzeCommits() yields "major" for a breaking change when under cap', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '1.2.3' },
      commits: [commit('feat!: this is breaking')],
    });

    expect(await analyzeCommits({ repo: 'cli/cli' }, context)).toBe('major');
  });

  it('analyzeCommits() blocks a major bump if cap is too low', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '2.0.0' },
      commits: [commit('feat!: another break')],
    });

    await expect(analyzeCommits({ repo: 'cli/cli' }, context)).rejects.toThrow(
      /Blocked: next major/,
    );
  });

  it('analyzeCommits() passes through non-major bump', async () => {
    const { context } = stepContext<AnalyzeContext>({
      lastRelease: { version: '3.0.0' },
      commits: [commit('fix: update README')],
    });

    expect(await analyzeCommits({ repo: 'cli/cli' }, context)).toBe('patch');
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
    const make = () =>
      stepContext<
        VerifyConditionsContext & { majorCapFromUpstream?: number }
      >();

    it('requires a repo', async () => {
      const { context } = make();

      await expect(verifyConditions({ repo: '' }, context)).rejects.toThrow(
        'Missing required config "repo".',
      );
    });

    it('stores the major of the highest semver tag, ignoring other tags', async () => {
      const list = upstream(['v1.2.0', 'latest', 'v3.1.0', 'v2.0.0']);
      const { context, lines } = make();

      await verifyConditions({ repo: 'o/r', githubToken: 'T' }, context);

      expect(context.majorCapFromUpstream).toBe(3);
      expect(list).toHaveBeenCalledWith('o/r');
      expect(lines).toContain('Latest tag is "v3.1.0" → major cap = 3.');
    });

    it('fails when no release has a semver tag', async () => {
      upstream(['latest', 'nightly']);
      const { context } = make();

      await expect(verifyConditions({ repo: 'o/r' }, context)).rejects.toThrow(
        'No valid semver release tags found among the latest 100 releases for o/r. Unable to determine the latest version.',
      );
      expect(context.majorCapFromUpstream).toBeUndefined();
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

    it('uses the commit analyzer configuration it is given', async () => {
      const { context, lines } = make('fix: a bug');

      const result = await analyzeCommits(
        {
          repo: 'o/r',
          commitAnalyzerConfig: { preset: 'angular' },
        },
        context,
      );

      expect(result).toBe('patch');
      expect(lines).toContain(
        'Using provided commitAnalyzerConfig for base analyzer.',
      );
    });

    it('defaults to the conventionalcommits preset', async () => {
      const { context, lines } = make('fix: a bug');

      await analyzeCommits({ repo: 'o/r', commitAnalyzerConfig: {} }, context);

      expect(lines[0]).toMatch(
        /defaulting to \{ preset: "conventionalcommits" \}/,
      );
    });
  });
});
