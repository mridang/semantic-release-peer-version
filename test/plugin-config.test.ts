import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { customCommitAnalyzerConfig } from '../src/plugin-config.js';

describe('customCommitAnalyzerConfig', () => {
  it('gives the configuration when it has options', () => {
    expect(
      customCommitAnalyzerConfig({
        repo: 'o/r',
        commitAnalyzerConfig: { preset: 'angular' },
      }),
    ).toEqual({ preset: 'angular' });
  });

  it('is undefined when the option is missing or empty', () => {
    expect(customCommitAnalyzerConfig({ repo: 'o/r' })).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: {} }),
    ).toBeUndefined();
    expect(
      customCommitAnalyzerConfig({ repo: 'o/r', commitAnalyzerConfig: null }),
    ).toBeUndefined();
  });
});
