import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { truncate } from '../../src/utils/text.js';

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('', 3)).toBe('');
  });

  it('cuts longer text and marks it', () => {
    expect(truncate('abcdef', 3)).toBe('abc... (truncated)');
  });
});
