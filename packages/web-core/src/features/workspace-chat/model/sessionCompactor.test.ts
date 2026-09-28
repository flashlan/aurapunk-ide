import { describe, expect, it } from 'vitest';
import {
  buildAgentCompactionMarker,
  buildCompactionNotice,
  compactionService,
} from './sessionCompactor';

describe('sessionCompactor', () => {
  it('records the agent compaction as a marker without claiming a summary', () => {
    const marker = buildAgentCompactionMarker(120_000);
    expect(marker.type).toBe('NORMALIZED_ENTRY');
    if (marker.type !== 'NORMALIZED_ENTRY') return;
    expect(marker.content.entry_type).toMatchObject({
      type: 'compaction_marker',
      previous_tokens: 120_000,
      mem0_synced: false,
    });
    expect(marker.content.content).toContain('/compact');
    expect(marker.content.content).not.toMatch(/Mem0|Redução/);
  });

  it('omits the size when the context size is unknown', () => {
    const marker = buildAgentCompactionMarker(undefined);
    if (marker.type !== 'NORMALIZED_ENTRY') throw new Error('unexpected');
    expect(marker.content.content).not.toContain('tokens)');
  });

  it('reports failures against the configured engine', () => {
    expect(compactionService('jev')).toBe('jev');
    expect(compactionService('laya')).toBe('laya');
    expect(buildCompactionNotice('x').type).toBe('NORMALIZED_ENTRY');
  });
});
