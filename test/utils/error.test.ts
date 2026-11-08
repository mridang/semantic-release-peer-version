import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { messageOf } from '../../src/utils/error.js';

describe('messageOf', () => {
  it('reads the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('falls back to the code of an error without a message', () => {
    expect(
      messageOf(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
  });

  it('falls back to the first inner error of an aggregate without a message', () => {
    expect(
      messageOf(
        new AggregateError([new Error('connect ECONNREFUSED ::1:80')], ''),
      ),
    ).toBe('connect ECONNREFUSED ::1:80');
  });

  it('falls back to the name when nothing else describes the error', () => {
    expect(messageOf(new AggregateError([], ''))).toBe('AggregateError');
    expect(messageOf(new TypeError(''))).toBe('TypeError');
  });

  it('uses the string form of anything else', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });
});
