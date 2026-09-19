/**
 * @aurapunk/jev-plugin
 * Fast Jev & RLCD Semantic Graph & Vector Extractor for Mem0
 * 
 * Provides deterministic, zero-token entity & relation extraction
 * and fact durability classification (<1ms, local CPU).
 */

export interface ExtractedEntity {
  name: string;
  type: 'architecture' | 'module' | 'file' | 'endpoint' | 'decision' | 'convention' | 'dependency' | 'concept' | 'tech';
  description: string;
}

export interface ExtractedRelation {
  subject: string;
  predicate: 'depends_on' | 'imports' | 'implements' | 'calls' | 'routes_to' | 'configures' | 'is_plugin_for' | 'extends' | 'uses' | 'fixes';
  object: string;
}

export interface Mem0ExtractionResult {
  facts: string[];
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  durabilityScore: number; // 0.0 - 1.0 (RLCD score)
  isVolatile: boolean;
  engine: 'fast-jev' | 'laya-classifier';
}

export interface Mem0ExtractorOptions {
  engine?: 'fast-jev' | 'laya-classifier';
  minDurabilityScore?: number;
  maxFacts?: number;
  maxEntities?: number;
  maxRelations?: number;
}

// Patterns identifying ephemeral/volatile transient logs and noise
const VOLATILE_PATTERNS = [
  /error\[E\d+\]/i,
  /TypeError:/i,
  /ReferenceError:/i,
  /SyntaxError:/i,
  /Uncaught\s+/i,
  /exit code\s+[1-9]\d*/i,
  /Failed to compile/i,
  /Command failed:/i,
  /\[plugin:vite:/i,
  /at\s+[\w.<>$]+\s+\(/i, // stack traces
  /npm ERR!/i,
  /cargo build --/i,
  /git status/i,
  /pnpm (install|i|check)/i,
];

// Patterns identifying durable architectural facts and decisions
const DURABLE_PATTERNS = [
  /ADR-\d+/i,
  /architectur(e|al)/i,
  /decision/i,
  /migrat(e|ed|ion)/i,
  /refactor(ed|ing)?/i,
  /convention/i,
  /root cause/i,
  /endpoint/i,
  /protocol/i,
  /persistent/i,
  /deterministic/i,
  /relevance/i,
  /provenance/i,
  /commit_sha/i,
];

// Regex for file paths
const FILE_PATH_REGEX = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|rs|py|json|toml|yaml|yml|md|html|css)\b/g;

// Regex for code symbols / identifiers (PascalCase, e.g. React components, Rust structs)
const PASCAL_CASE_REGEX = /\b[A-Z][a-zA-Z0-9]{2,}(?:Service|Container|Viewer|Section|Plugin|Compactor|Classifier|Adapter|Engine|Router|Config|Request|Response|Handler|Driver|Store)\b/g;

// Regex for HTTP routes / endpoints
const HTTP_ROUTE_REGEX = /(?:POST|GET|PUT|PATCH|DELETE)\s+(\/[a-zA-Z0-9_\-\/{}:]+)|\b(\/api\/[a-zA-Z0-9_\-\/{}:]+)\b/g;

// Regex for crates / packages
const CRATE_PACKAGE_REGEX = /\b(?:crates\/[a-zA-Z0-9_\-]+|packages\/[a-zA-Z0-9_\-]+|@[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+)\b/g;

/**
 * Classifies whether a fact or statement is durable (long-term value)
 * or volatile (ephemeral noise like compile logs, stack traces).
 */
export function classifyFactDurability(text: string): {
  score: number;
  isVolatile: boolean;
  category: 'architectural_decision' | 'convention' | 'factual_change' | 'transient_noise';
} {
  let volatileCount = 0;
  for (const pattern of VOLATILE_PATTERNS) {
    if (pattern.test(text)) volatileCount++;
  }

  let durableCount = 0;
  for (const pattern of DURABLE_PATTERNS) {
    if (pattern.test(text)) durableCount++;
  }

  // Base score from length and structural clues
  let score = 0.6;

  if (volatileCount > 0) {
    score -= volatileCount * 0.25;
  }
  if (durableCount > 0) {
    score += durableCount * 0.2;
  }

  // Clues from code paths or structural names
  if (FILE_PATH_REGEX.test(text) || HTTP_ROUTE_REGEX.test(text)) {
    score += 0.1;
  }

  score = Math.max(0.0, Math.min(1.0, score));
  const isVolatile = score < 0.4 || volatileCount >= 2;

  let category: 'architectural_decision' | 'convention' | 'factual_change' | 'transient_noise' = 'factual_change';
  if (isVolatile) {
    category = 'transient_noise';
  } else if (/ADR-|architectur|decision/i.test(text)) {
    category = 'architectural_decision';
  } else if (/convention|rule|standard|always|never/i.test(text)) {
    category = 'convention';
  }

  return { score, isVolatile, category };
}

/**
 * Deterministically extracts entities (modules, files, components, endpoints, tech)
 * from technical text without requiring a generative LLM call.
 */
export function extractEntitiesDeterministic(text: string, maxEntities = 8): ExtractedEntity[] {
  const entities: Map<string, ExtractedEntity> = new Map();

  // 1. Extract file paths
  const fileMatches = text.match(FILE_PATH_REGEX) || [];
  for (const file of fileMatches) {
    if (!entities.has(file)) {
      const isDoc = file.endsWith('.md');
      entities.set(file, {
        name: file,
        type: isDoc ? 'decision' : 'file',
        description: isDoc ? 'Documentation / ADR reference' : 'Source file',
      });
    }
  }

  // 2. Extract crates and packages
  const pkgMatches = text.match(CRATE_PACKAGE_REGEX) || [];
  for (const pkg of pkgMatches) {
    if (!entities.has(pkg)) {
      entities.set(pkg, {
        name: pkg,
        type: 'module',
        description: pkg.startsWith('crates/') ? 'Rust workspace crate' : 'TypeScript package',
      });
    }
  }

  // 3. Extract endpoints
  let routeMatch: RegExpExecArray | null;
  const routeRegex = new RegExp(HTTP_ROUTE_REGEX);
  while ((routeMatch = routeRegex.exec(text)) !== null) {
    const route = routeMatch[1] || routeMatch[2];
    if (route && !entities.has(route)) {
      entities.set(route, {
        name: route,
        type: 'endpoint',
        description: 'REST API route',
      });
    }
  }

  // 4. Extract PascalCase architectural components
  const symbolMatches = text.match(PASCAL_CASE_REGEX) || [];
  for (const sym of symbolMatches) {
    if (!entities.has(sym)) {
      entities.set(sym, {
        name: sym,
        type: 'architecture',
        description: 'System architectural component or service',
      });
    }
  }

  // 5. Extract specific known technologies
  const techKeywords = [
    { name: 'Mem0', desc: 'Long-term agentic memory store', type: 'tech' as const },
    { name: 'FastJev', desc: 'Sub-millisecond token compactor & extractor', type: 'architecture' as const },
    { name: 'Laya', desc: 'RLCD autonomous decision classifier', type: 'architecture' as const },
    { name: 'Qdrant', desc: 'Vector similarity database', type: 'tech' as const },
    { name: 'NetworkX', desc: 'Directed semantic knowledge graph', type: 'tech' as const },
    { name: 'Graphify', desc: 'Interactive memory graph viewer', type: 'architecture' as const },
  ];

  for (const kw of techKeywords) {
    const regex = new RegExp(`\\b${kw.name}\\b`, 'i');
    if (regex.test(text) && !entities.has(kw.name)) {
      entities.set(kw.name, {
        name: kw.name,
        type: kw.type,
        description: kw.desc,
      });
    }
  }

  return Array.from(entities.values()).slice(0, maxEntities);
}

/**
 * Deterministically extracts semantic relations between detected entities.
 */
export function extractRelationsDeterministic(
  text: string,
  entities: ExtractedEntity[],
  maxRelations = 10
): ExtractedRelation[] {
  const relations: ExtractedRelation[] = [];

  // Helper to check co-occurrence and directional cue
  const searchRel = (
    predicate: ExtractedRelation['predicate'],
    cuePatterns: RegExp[]
  ) => {
    for (let i = 0; i < entities.length; i++) {
      for (let j = 0; j < entities.length; j++) {
        if (i === j) continue;
        const e1 = entities[i].name;
        const e2 = entities[j].name;

        for (const cue of cuePatterns) {
          // Check if pattern "e1 ... cue ... e2" exists
          const escapedE1 = e1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedE2 = e2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`${escapedE1}[^.\\n]{0,80}?${cue.source}[^.\\n]{0,80}?${escapedE2}`, 'i');
          if (regex.test(text)) {
            relations.push({
              subject: e1,
              predicate,
              object: e2,
            });
            return;
          }
        }
      }
    }
  };

  // Relation rules
  searchRel('depends_on', [/depends\s+on/i, /relies\s+on/i, /requires/i]);
  searchRel('imports', [/imports/i, /uses\s+module/i]);
  searchRel('implements', [/implements/i, /satisfies/i]);
  searchRel('routes_to', [/routes\s+to/i, /handlers?\s+for/i]);
  searchRel('calls', [/calls/i, /invokes/i, /dispatches/i]);
  searchRel('is_plugin_for', [/plugin\s+for/i, /extension\s+for/i]);
  searchRel('configures', [/configures/i, /manages/i]);
  searchRel('fixes', [/fixes/i, /resolves/i]);

  // Structural inferences (e.g. Crate / File -> Component)
  for (const ent of entities) {
    if (ent.type === 'file') {
      for (const other of entities) {
        if (other.type === 'architecture' && text.includes(ent.name) && text.includes(other.name)) {
          // If a file defines/exports a component
          if (!relations.some((r) => r.subject === ent.name && r.object === other.name)) {
            relations.push({
              subject: ent.name,
              predicate: 'implements',
              object: other.name,
            });
          }
        }
      }
    }
  }

  return relations.slice(0, maxRelations);
}

/**
 * Main Mem0 Structure Extractor using Fast Jev / RLCD.
 * Returns self-contained facts, classified entities, and relations.
 */
export function extractMem0Structure(
  text: string,
  options: Mem0ExtractorOptions = {}
): Mem0ExtractionResult {
  const engine = options.engine ?? 'fast-jev';
  const minScore = options.minDurabilityScore ?? 0.35;
  const maxFacts = options.maxFacts ?? 4;
  const maxEntities = options.maxEntities ?? 8;
  const maxRelations = options.maxRelations ?? 10;

  const durability = classifyFactDurability(text);

  // If the text is pure transient noise and durability is very low,
  // return empty or clean fallback so it doesn't pollute the vector/graph store.
  if (durability.isVolatile && durability.score < minScore) {
    return {
      facts: [],
      entities: [],
      relations: [],
      durabilityScore: durability.score,
      isVolatile: true,
      engine,
    };
  }

  // Split text into coherent sentences/statements
  const rawLines = text
    .split(/\n|\.\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15 && !VOLATILE_PATTERNS.some((p) => p.test(s)));

  const facts: string[] = [];
  for (const line of rawLines) {
    const cleaned = line
      .replace(/^[-*•]\s+/, '')
      .replace(/^I\s+(have\s+)?(will|added|fixed|implemented|verified)\s+/i, '')
      .trim();
    if (cleaned.length >= 15 && !facts.includes(cleaned)) {
      facts.push(cleaned);
    }
    if (facts.length >= maxFacts) break;
  }

  if (facts.length === 0 && !durability.isVolatile) {
    facts.push(text.slice(0, 280).trim());
  }

  const entities = extractEntitiesDeterministic(text, maxEntities);
  const relations = extractRelationsDeterministic(text, entities, maxRelations);

  return {
    facts,
    entities,
    relations,
    durabilityScore: durability.score,
    isVolatile: durability.isVolatile,
    engine,
  };
}

/**
 * Graph Pruning Helper:
 * Evaluates nodes against existing workspace symbols or file paths to detect
 * dead/stale references for Graphify and Mem0.
 */
export function pruneStaleGraphNodes(
  nodes: Array<{ id: string; type: string }>,
  existingSymbolsOrFiles: Set<string>
): { keep: string[]; stale: string[] } {
  const keep: string[] = [];
  const stale: string[] = [];

  for (const node of nodes) {
    // If it is a file or module node, check if it exists in the active set
    if (node.type === 'file' || node.type === 'module') {
      if (existingSymbolsOrFiles.has(node.id)) {
        keep.push(node.id);
      } else {
        stale.push(node.id);
      }
    } else {
      // Concepts and general decisions remain unless explicitly flagged
      keep.push(node.id);
    }
  }

  return { keep, stale };
}
