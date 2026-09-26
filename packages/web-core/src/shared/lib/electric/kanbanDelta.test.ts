import { describe, expect, it } from 'vitest';
import { frameTargetsSubscription } from './kanbanDelta';

const board = { table: 'issues', minimal: false };
const sidebar = { table: 'issues', minimal: true };

describe('frameTargetsSubscription', () => {
  it('routes a minimal issues frame only to the minimal subscription', () => {
    const frame = { table: 'issues', minimal: true };
    expect(frameTargetsSubscription(frame, sidebar)).toBe(true);
    expect(frameTargetsSubscription(frame, board)).toBe(false);
  });

  it('routes a full issues frame only to the full subscription', () => {
    const frame = { table: 'issues', minimal: false };
    expect(frameTargetsSubscription(frame, board)).toBe(true);
    expect(frameTargetsSubscription(frame, sidebar)).toBe(false);
  });

  it('treats frames without a projection (older servers) as full rows', () => {
    expect(frameTargetsSubscription({ table: 'issues' }, board)).toBe(true);
    expect(frameTargetsSubscription({ table: 'issues' }, sidebar)).toBe(false);
  });

  it('never crosses tables', () => {
    expect(
      frameTargetsSubscription({ table: 'tags', minimal: false }, board)
    ).toBe(false);
  });
});
