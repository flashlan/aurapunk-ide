/**
 * @aurapunk/jev-plugin
 * Universal Fast Jev Compaction and Laya System-1 Decision Engine
 */

export * from "./types.js";
export {
  compactMessages,
  calculateReductionRatio,
} from "./compactor/engine.js";
export {
  estimateTokens,
  fitState,
  formatToolCall,
  formatToolResultSummary,
} from "./compactor/fitter.js";
export type { DecisionClassifier } from "./classifiers/interface.js";
export { JevClassifier } from "./classifiers/jev_classifier.js";
export { LayaClassifier } from "./classifiers/laya_classifier.js";
export { AdaptiveClassifier } from "./classifiers/adaptive_classifier.js";
export {
  AgentDecisionEngine,
  DEFAULT_TOOLS,
  DEFAULT_AGENTS,
  type AgentStepInput,
} from "./laya/agent_decision_engine.js";
export {
  universalAutoCompact,
  TranscriptConverter,
  type UniversalCompactorOptions,
  type UniversalCompactionOutput,
  type SupportedFormat,
} from "./autocompact/universal_compactor.js";
export {
  isolateAndCompactContext,
  type ContextIsolationOptions,
  type IsolatedContextResult,
} from "./autocompact/context_isolator.js";
export {
  extractMem0Structure,
  classifyFactDurability,
  extractEntitiesDeterministic,
  extractRelationsDeterministic,
  pruneStaleGraphNodes,
  type ExtractedEntity,
  type ExtractedRelation,
  type Mem0ExtractionResult,
  type Mem0ExtractorOptions,
} from "./mem0/mem0_extractor.js";
export {
  evaluateDiffRules,
  AURAPUNK_STANDARD_RULES,
  type AbideRule,
  type RuleViolation,
  type RuleEvaluationResult,
  type EvaluateDiffOptions,
} from "./guardrails/abide_guardrails.js";
export { handleSessionCompact } from "../hooks/fast-jev.js";
