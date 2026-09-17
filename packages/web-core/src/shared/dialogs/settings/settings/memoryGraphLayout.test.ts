import { describe, expect, it } from 'vitest';
import {
  computeGraphLayout,
  nodeMatchesQuery,
  seededUnit,
  typeColorIndex,
} from './memoryGraphLayout';

const NODES = [{ id: 'Auth' }, { id: 'Database' }, { id: 'Cache' }];
const EDGES = [
  { subject: 'Auth', object: 'Database' },
  { subject: 'Database', object: 'Cache' },
];

describe('seededUnit', () => {
  it('is deterministic and bounded to [0, 1)', () => {
    expect(seededUnit('Auth:x')).toBe(seededUnit('Auth:x'));
    expect(seededUnit('Auth:x')).toBeGreaterThanOrEqual(0);
    expect(seededUnit('Auth:x')).toBeLessThan(1);
    expect(seededUnit('Auth:x')).not.toBe(seededUnit('Auth:y'));
  });
});

describe('computeGraphLayout', () => {
  it('returns a stable position per node within the canvas bounds', () => {
    const first = computeGraphLayout(NODES, EDGES, 880, 340);
    const second = computeGraphLayout(NODES, EDGES, 880, 340);
    expect(first.size).toBe(3);
    for (const node of NODES) {
      const a = first.get(node.id);
      const b = second.get(node.id);
      expect(a).toBeDefined();
      expect(a).toEqual(b);
      expect(a!.x).toBeGreaterThanOrEqual(28);
      expect(a!.x).toBeLessThanOrEqual(880 - 28);
      expect(a!.y).toBeGreaterThanOrEqual(24);
      expect(a!.y).toBeLessThanOrEqual(340 - 24);
    }
  });

  it('ignores edges that reference unknown nodes', () => {
    const layout = computeGraphLayout(
      NODES,
      [
        ...EDGES,
        { subject: 'Ghost', object: 'Auth' },
        { subject: 'Cache', object: 'Missing' },
      ],
      880,
      340
    );
    expect(layout.size).toBe(3);
  });

  it('handles an empty graph', () => {
    expect(computeGraphLayout([], [], 880, 340).size).toBe(0);
  });
});

describe('nodeMatchesQuery', () => {
  const node = {
    id: 'RateLimiter',
    type: 'module',
    description: 'Caps requests',
  };

  it('matches case-insensitively across id, type and description', () => {
    expect(nodeMatchesQuery(node, 'ratelimiter')).toBe(true);
    expect(nodeMatchesQuery(node, 'MODULE')).toBe(true);
    expect(nodeMatchesQuery(node, 'caps')).toBe(true);
    expect(nodeMatchesQuery(node, 'database')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(nodeMatchesQuery(node, '   ')).toBe(true);
  });
});

describe('typeColorIndex', () => {
  it('is stable and stays inside the palette', () => {
    expect(typeColorIndex('module', 8)).toBe(typeColorIndex('module', 8));
    for (const type of ['module', 'concept', '', 'decision']) {
      const index = typeColorIndex(type, 8);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(8);
    }
  });
});
