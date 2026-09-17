/**
 * Deterministic force-directed layout for the mem0 knowledge graph.
 *
 * Graphify-style rendering needs stable node positions: the same graph must
 * produce the same map on every render, without keeping physics state alive
 * between React renders. This module is pure (no React) so it stays cheap to
 * unit-test.
 */

export interface GraphLayoutNode {
  id: string;
}

export interface GraphLayoutEdge {
  subject: string;
  object: string;
}

export interface GraphLayoutPoint {
  x: number;
  y: number;
  /** Stable per-node jitter in [0, 1) used for radius variation. */
  z: number;
}

/** FNV-1a hash mapped to a unit float in [0, 1). */
export function seededUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Bounded force layout: Coulomb-style repulsion between every node pair plus
 * spring attraction along edges, run for a fixed number of iterations from
 * seeded start positions. Positions are clamped to the canvas bounds.
 */
export function computeGraphLayout(
  nodes: readonly GraphLayoutNode[],
  edges: readonly GraphLayoutEdge[],
  width: number,
  height: number,
  iterations = 90
): Map<string, GraphLayoutPoint> {
  const marginX = 28;
  const marginY = 24;
  const positions = new Map<string, GraphLayoutPoint>(
    nodes.map((node) => [
      node.id,
      {
        x: marginX + seededUnit(`${node.id}:x`) * (width - marginX * 2),
        y: marginY + seededUnit(`${node.id}:y`) * (height - marginY * 2),
        z: seededUnit(`${node.id}:z`),
      },
    ])
  );
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const force = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = positions.get(nodes[left].id);
        const b = positions.get(nodes[right].id);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(16, Math.hypot(dx, dy));
        const strength = 1100 / (distance * distance);
        force.get(nodes[left].id)!.x += (dx / distance) * strength;
        force.get(nodes[left].id)!.y += (dy / distance) * strength;
        force.get(nodes[right].id)!.x -= (dx / distance) * strength;
        force.get(nodes[right].id)!.y -= (dy / distance) * strength;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.subject);
      const b = positions.get(edge.object);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (distance - 105) * 0.012;
      force.get(edge.subject)!.x += (dx / distance) * strength;
      force.get(edge.subject)!.y += (dy / distance) * strength;
      force.get(edge.object)!.x -= (dx / distance) * strength;
      force.get(edge.object)!.y -= (dy / distance) * strength;
    }
    for (const node of nodes) {
      const point = positions.get(node.id);
      const movement = force.get(node.id);
      if (!point || !movement) continue;
      point.x = Math.min(
        width - marginX,
        Math.max(marginX, point.x + movement.x)
      );
      point.y = Math.min(
        height - marginY,
        Math.max(marginY, point.y + movement.y)
      );
    }
  }
  return positions;
}

export interface GraphSearchNode {
  id: string;
  type: string;
  description: string;
}

/** Case-insensitive substring match across id, type and description. */
export function nodeMatchesQuery(
  node: GraphSearchNode,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    node.id.toLowerCase().includes(needle) ||
    node.type.toLowerCase().includes(needle) ||
    node.description.toLowerCase().includes(needle)
  );
}

/** Stable palette slot for a node type label. */
export function typeColorIndex(type: string, paletteSize: number): number {
  if (paletteSize <= 0) return 0;
  const unit = seededUnit(`type:${type || 'unknown'}`);
  return Math.min(paletteSize - 1, Math.floor(unit * paletteSize));
}
