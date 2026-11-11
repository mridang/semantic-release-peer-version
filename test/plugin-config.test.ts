/**
 * @file Tests for the plugin configuration checks.
 */

import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  assertRepo,
  customCommitAnalyzerConfig,
} from '../src/plugin-config.js';

describe('customCommitAnalyzerConfig', () => {
  it('gives the configuration when it has options', () => {
    expect(
      customCommitAnalyzerConfig({
        repo: 'o/r',
        commitAnalyzerConfig: { preset: 'angular' },
      }),
    ).toEqual({ preset: 'angular' });
  });

  it.each(['angular', ['a']])('hands %p to the analyzer as it is', (value) => {
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: value }),
    ).toBe(value);
  });

  it('is undefined when the option is missing or empty', () => {
    expect(customCommitAnalyzerConfig({ repo: 'o/r' })).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: {} }),
    ).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: null }),
    ).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: '' }),
    ).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: [] }),
    ).toBeUndefined();
  });
});

describe('assertRepo', () => {
  it.each([
    'cli/cli',
    'semantic-release/semantic-release',
    'o/r.js',
    'a_b/c-d',
  ])('accepts %s', (repo) => {
    expect(() => assertRepo(repo)).not.toThrow();
  });

  it.each([undefined, null, ''])('reports %p as missing', (repo) => {
    expect(() => assertRepo(repo)).toThrow('Missing required config "repo".');
  });

  it.each([
    'o',
    'o/r?per_page=1',
    'o/r/../../x',
    '../r',
    'o/..',
    './r',
    'o/r/extra',
    'o /r',
    '/o/r',
    'o/r#frag',
    5,
  ])('rejects %p with EINVALIDREPO', (repo) => {
    expect(() => assertRepo(repo)).toThrow(
      expect.objectContaining({ code: 'EINVALIDREPO' }),
    );
  });
});
