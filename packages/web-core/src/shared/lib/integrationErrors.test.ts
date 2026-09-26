import { describe, expect, it } from 'vitest';
import { describeError } from './integrationErrors';
import { compactionService } from '@/features/workspace-chat/model/sessionCompactor';

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('HTTP 401'))).toBe('HTTP 401');
  });

  it('falls back to the name of an Error without a message', () => {
    expect(describeError(new TypeError())).toBe('TypeError');
  });

  it('keeps strings and serializes plain objects', () => {
    expect(describeError('timeout')).toBe('timeout');
    expect(describeError({ status: 502 })).toBe('{"status":502}');
  });
});

describe('compactionService', () => {
  it('attributes Jev compactions to Jev and everything else to Laya', () => {
    expect(compactionService('jev')).toBe('jev');
    expect(compactionService('laya')).toBe('laya');
    expect(compactionService('auto')).toBe('laya');
  });
});
