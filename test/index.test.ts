import { describe, expect, it, jest } from '@jest/globals';

import semver from 'semver';
// noinspection ES6PreferShortImport
import { analyzeCommits, verifyConditions } from '../src/index.js';
import type {
  AnalyzeCommitsContext,
  VerifyConditionsContext,
} from 'semantic-release';

jest.setTimeout(30000);

describe('Integration: block-major plugin hooks', () => {
  const logger = {
    log: () => {},
  };

  it('verifyConditions() reads the real latest semver tag', async () => {
    const ctx = {
      logger,
      cwd: process.cwd(),
    } as unknown as VerifyConditionsContext & { majorCapFromUpstream: number };

    await verifyConditions({ repo: 'cli/cli' }, ctx);
    expect(typeof ctx.majorCapFromUpstream).toBe('number');
    expect(ctx.majorCapFromUpstream).toBeGreaterThanOrEqual(0);
    const res = await fetch(
      `https://api.github.com/repos/cli/cli/tags?per_page=1`,
    );
    const tags = (await res.json()) as Array<{ name: string }>;
    const [t] = tags;
    expect(ctx.majorCapFromUpstream).toBe(semver.major(t.name));
  });

  it('analyzeCommits() yields "major" for a breaking change when under cap', async () => {
    const commits = [
      { header: 'feat!: this is breaking', message: 'feat!: this is breaking' },
    ];
    const ctx = {
      lastRelease: { version: '1.2.3' },
      commits,
      majorCapFromUpstream: 100,
      logger,
      cwd: process.cwd(),
    } as unknown as AnalyzeCommitsContext & { majorCapFromUpstream: number };

    const result = await analyzeCommits({ repo: 'cli/cli' }, ctx);
    expect(result).toBe('major');
  });

  it('analyzeCommits() blocks a major bump if cap is too low', async () => {
    const commits = [
      { header: 'feat!: another break', message: 'feat!: another break' },
    ];
    const ctx = {
      lastRelease: { version: '2.0.0' },
      commits,
      majorCapFromUpstream: 2,
      logger,
      cwd: process.cwd(),
    } as unknown as AnalyzeCommitsContext & { majorCapFromUpstream: number };

    await expect(analyzeCommits({ repo: 'cli/cli' }, ctx)).rejects.toThrow(
      /Blocked: next major/,
    );
  });

  it('analyzeCommits() passes through non-major bump', async () => {
    const commits = [
      { header: 'fix: update README', message: 'fix: update README' },
    ];
    const ctx = {
      lastRelease: { version: '3.0.0' },
      commits,
      majorCapFromUpstream: 0,
      logger,
      cwd: process.cwd(),
    } as unknown as AnalyzeCommitsContext & { majorCapFromUpstream: number };

    const result = await analyzeCommits({ repo: 'cli/cli' }, ctx);
    expect(result).toBe('patch');
  });
});
