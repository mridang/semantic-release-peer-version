import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { hasCommitAnalyzerConfig } from '../src/plugin-config.js';

describe('hasCommitAnalyzerConfig', () => {
  it('is true for a configuration with options', () => {
    expect(hasCommitAnalyzerConfig({ preset: 'angular' })).toBe(true);
  });

  it('is false when the option is missing or empty', () => {
    expect(hasCommitAnalyzerConfig(undefined)).toBe(false);
    expect(hasCommitAnalyzerConfig({})).toBe(false);
  });
});
