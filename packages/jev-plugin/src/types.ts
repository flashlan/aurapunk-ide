/**
 * Core type definitions for Fast Jev Compaction and Laya Decision Engine
 */

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, any> | string;
}

export interface ToolResult {
  tool_use_id: string;
  text: string;
  is_error?: boolean;
}

export interface Message {
  role: Role;
  text?: string;
  toolUses?: ToolUse[];
  toolResults?: ToolResult[];
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Jev & Laya Decision Primitives
// ---------------------------------------------------------------------------

export type QuestionType = 'noul' | 'choice' | 'score';

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type TypedQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulResult {
  type: 'noul';
  probability: number; // Calibrated P(true) [0.0 - 1.0]
  verdict: boolean;
}

export interface ChoiceResult {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreResult {
  type: 'score';
  score: number; // Continuous score from 0.0 to criteria.length - 1
  levelIndex: number;
  levelLabel: string;
  confidence: number;
}

export type DecisionAnswer = NoulResult | ChoiceResult | ScoreResult;

export interface DecisionBatchResult {
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  model: string;
  provider: 'jev' | 'laya' | 'rule_fallback';
}

// ---------------------------------------------------------------------------
// Laya Standalone 9 Agent Decisions
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AgentStepAssessment {
  // 1. se alguma ferramenta é necessária
  needsTool: {
    needed: boolean;
    confidence: number;
  };
  // 2. qual ferramenta usar
  toolChoice: {
    tool: string;
    confidence: number;
    optionsEvaluated: string[];
  };
  // 3. se deve responder diretamente
  respondDirectly: {
    direct: boolean;
    confidence: number;
  };
  // 4. se faltam informações
  missingInformation: {
    hasMissingInfo: boolean;
    confidence: number;
  };
  // 5. se precisa pedir confirmação
  needsConfirmation: {
    required: boolean;
    confidence: number;
    reason?: string;
  };
  // 6. o nível de risco da operação
  riskLevel: {
    level: RiskLevel;
    score: number;
    confidence: number;
  };
  // 7. se deve escalar para um modelo maior
  escalateToLargerModel: {
    escalate: boolean;
    confidence: number;
    reason?: string;
  };
  // 8. se a chamada proposta combina com o pedido
  callMatchesRequest: {
    matches: boolean;
    confidence: number;
  };
  // 9. qual agente deve receber a tarefa
  agentRouting: {
    agent: string;
    confidence: number;
    candidates: string[];
  };
  // Metadata
  evaluatedAt: string;
  provider: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Compaction Configuration & Results
// ---------------------------------------------------------------------------

export type ClassifierProvider = 'auto' | 'jev' | 'laya';

export interface CompactionOptions {
  apiKey?: string;
  jevBaseUrl?: string;
  layaEndpoint?: string;
  provider?: ClassifierProvider;
  keepThreshold?: number; // Default 0.5
  preserveRecentMessages?: number; // Default 6
  truncateHeadChars?: number; // Default 300
  maxStateTokens?: number; // Default 25000
  maxRequestTokens?: number; // Default 30000
  goal?: string;
  fetchFn?: typeof fetch;
}

export interface ToolCallDecision {
  tool_use_id: string;
  tool: string;
  keepCall: number;
  keepResult: number;
  action: 'keep_full' | 'truncate_result' | 'drop_all';
}

export interface CompactionStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  reductionRatio: number;
  toolCallsTotal: number;
  toolCallsKeptFull: number;
  toolCallsTruncated: number;
  toolCallsDropped: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  providerUsed: 'jev' | 'laya' | 'rule_fallback';
  durationMs: number;
}

export interface CompactionResult {
  messages: Message[];
  decisions: ToolCallDecision[];
  stats: CompactionStats;
}
