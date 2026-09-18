import { describe, it, expect } from 'vitest';
import {
  classifyFactDurability,
  extractEntitiesDeterministic,
  extractRelationsDeterministic,
  extractMem0Structure,
  pruneStaleGraphNodes,
} from '../src/mem0/mem0_extractor.js';

describe('Fast Jev & Laya Mem0 Extractor', () => {
  it('classifies durable architectural decisions with high durability score', () => {
    const text = 'ADR-045 implemented the Graphify add-on renderer in Settings to visualize the Mem0 knowledge graph.';
    const classification = classifyFactDurability(text);
    expect(classification.isVolatile).toBe(false);
    expect(classification.score).toBeGreaterThanOrEqual(0.7);
    expect(classification.category).toBe('architectural_decision');
  });

  it('classifies transient compile errors as volatile noise', () => {
    const text = `
      error[E0432]: unresolved import 'crate::services::mem0'
      --> crates/server/src/routes/usage.rs:12:5
      Command failed: cargo build --workspace with exit code 101
      at ChildProcess.exithandler (node:child_process:430:12)
    `;
    const classification = classifyFactDurability(text);
    expect(classification.isVolatile).toBe(true);
    expect(classification.score).toBeLessThan(0.4);
    expect(classification.category).toBe('transient_noise');
  });

  it('extracts structured entities with specific types (files, modules, endpoints, tech)', () => {
    const text = `
      The component MemorySettingsSection in packages/web-core/src/shared/dialogs/settings/settings/MemorySettingsSection.tsx
      calls endpoint POST /api/usage/mem0-config to update runtime config.
      It routes data into Mem0 and visualizes via Graphify.
    `;
    const entities = extractEntitiesDeterministic(text);
    const names = entities.map((e) => e.name);

    expect(names).toContain('MemorySettingsSection');
    expect(names).toContain('packages/web-core/src/shared/dialogs/settings/settings/MemorySettingsSection.tsx');
    expect(names).toContain('/api/usage/mem0-config');
    expect(names).toContain('Mem0');
    expect(names).toContain('Graphify');

    const fileEntity = entities.find((e) => e.name.includes('.tsx'));
    expect(fileEntity?.type).toBe('file');

    const routeEntity = entities.find((e) => e.name.includes('/api/'));
    expect(routeEntity?.type).toBe('endpoint');
  });

  it('extracts deterministic relations between entities', () => {
    const text = 'crates/mcp depends on crates/services and routes to /api/usage/mem0-config.';
    const entities = extractEntitiesDeterministic(text);
    const relations = extractRelationsDeterministic(text, entities);

    expect(relations.length).toBeGreaterThan(0);
    const depRel = relations.find((r) => r.predicate === 'depends_on');
    expect(depRel).toBeDefined();
    expect(depRel?.subject).toBe('crates/mcp');
    expect(depRel?.object).toBe('crates/services');
  });

  it('runs complete extractMem0Structure returning clean facts, entities, and relations', () => {
    const text = `
      Migrated extraction engine to Fast Jev.
      The MemorySettingsSection configures Mem0 with Laya classifier.
      Fixed context drift issue in crates/services/src/services/mem0_relevance.rs.
    `;
    const result = extractMem0Structure(text, { engine: 'laya-classifier' });
    expect(result.isVolatile).toBe(false);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.engine).toBe('laya-classifier');
  });

  it('prunes stale graph nodes that do not exist in active file list', () => {
    const nodes = [
      { id: 'crates/mcp/src/lib.rs', type: 'file' },
      { id: 'old_deleted_file.rs', type: 'file' },
      { id: 'DecisionsAndPatterns', type: 'concept' },
    ];
    const existing = new Set(['crates/mcp/src/lib.rs']);

    const { keep, stale } = pruneStaleGraphNodes(nodes, existing);
    expect(keep).toContain('crates/mcp/src/lib.rs');
    expect(keep).toContain('DecisionsAndPatterns'); // concepts are kept
    expect(stale).toContain('old_deleted_file.rs'); // deleted file is pruned
  });
});
