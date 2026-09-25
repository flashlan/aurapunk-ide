import { describe, expect, it } from 'vitest';
import {
  resolveScrollIntent,
  shouldReleaseBottomLock,
  shouldResumeFollow,
} from './conversation-scroll-commands';

describe('resolveScrollIntent', () => {
  it('preserves the current anchor while older history is inserted', () => {
    expect(resolveScrollIntent('historic', false, true)).toEqual({
      type: 'preserve-anchor',
    });
  });

  it('follows live messages when the user is at the bottom', () => {
    expect(resolveScrollIntent('running', false, true)).toEqual({
      type: 'follow-bottom',
      behavior: 'auto',
    });
  });

  it('preserves the reader position when live messages arrive above it', () => {
    expect(resolveScrollIntent('running', false, false)).toEqual({
      type: 'preserve-anchor',
    });
  });
});

describe('shouldReleaseBottomLock', () => {
  // maxScroll = 1000 (scrollHeight 1400, clientHeight 400)
  it('releases when the user scrolls up away from the bottom', () => {
    expect(shouldReleaseBottomLock(true, 1000, 600, 1000, false)).toBe(true);
  });

  it('releases on small upward steps anywhere below the bottom', () => {
    expect(shouldReleaseBottomLock(true, 603, 600, 1000, false)).toBe(true);
  });

  it('keeps the lock for programmatic writes that land on maxScroll', () => {
    expect(shouldReleaseBottomLock(true, 600, 1000, 1000, false)).toBe(false);
  });

  it('keeps the lock for downward scrolls', () => {
    expect(shouldReleaseBottomLock(true, 400, 600, 1000, false)).toBe(false);
  });

  it('keeps the lock while programmatic correction is suppressed', () => {
    expect(shouldReleaseBottomLock(true, 1000, 600, 1000, true)).toBe(false);
  });

  it('ignores scroll events when the lock is not held', () => {
    expect(shouldReleaseBottomLock(false, 1000, 600, 1000, false)).toBe(false);
  });

  it('ignores sub-pixel jitter', () => {
    expect(shouldReleaseBottomLock(true, 601, 600, 1000, false)).toBe(false);
  });
});

describe('shouldResumeFollow', () => {
  // scrollHeight 1400, clientHeight 400 => near-bottom band starts at 936
  it('resumes when the user actively scrolls down into the near-bottom band', () => {
    expect(shouldResumeFollow(true, 900, 960, 400, 1400)).toBe(true);
  });

  it('does NOT resume while scrolling up through the near-bottom band', () => {
    expect(shouldResumeFollow(true, 960, 900, 400, 1400)).toBe(false);
  });

  it('does not resume when the downward scroll is still far from the bottom', () => {
    expect(shouldResumeFollow(true, 100, 200, 400, 1400)).toBe(false);
  });

  it('does nothing when follow was never paused', () => {
    expect(shouldResumeFollow(false, 900, 960, 400, 1400)).toBe(false);
  });
});
