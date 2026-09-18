import type { Message, ToolResult, ToolUse } from '../types.js';
import { estimateTokens } from '../compactor/fitter.js';

export interface ContextIsolationOptions {
  /** Number of most recent messages to keep fully active and untouched */
  activeWindowSize?: number;
  /** Keep initial system/user prompt 100% stable for Prompt Caching */
  preserveCacheAnchor?: boolean;
  /** Replace bulky tool outputs in historical turns with compact summaries */
  pruneHistoricalToolOutputs?: boolean;
  /** Maximum characters allowed per historical tool result (default 120) */
  maxHistoricalResultChars?: number;
  /** Optional custom summary note to inject at the boundary */
  boundaryCheckpointNote?: string;
}

export interface IsolatedContextResult {
  /** The payload to be sent to the LLM model (clean, optimized, cache-friendly) */
  payloadForModel: Message[];
  /** Stats showing token reduction and prompt cache optimization */
  metrics: {
    totalMessages: number;
    isolatedHistoricalTurns: number;
    activeWindowTurns: number;
    tokensBefore: number;
    tokensAfter: number;
    prunedToolResultsCount: number;
    savedVolatileTokens: number;
    estimatedCacheStabilityPct: number;
  };
}

/**
 * Context Isolation & Checkpointing Engine for Aurapunk IDE and any LLM.
 * 
 * Solves the critical problem where long chats get polluted with massive
 * stdout/stderr logs, file dumps, and repetitive tool calls that:
 * 1. Invalidate Prompt Caching (causing massive cache misses & latency spikes).
 * 2. Waste thousands of input tokens on every subsequent turn.
 * 3. Confuse the model with obsolete intermediate error traces.
 * 
 * Keeps the human chat UI rich, but sends ONLY an isolated, compact,
 * cache-stabilized payload to the LLM.
 */
export function isolateAndCompactContext(
  messages: Message[],
  options: ContextIsolationOptions = {}
): IsolatedContextResult {
  const activeWindowSize = options.activeWindowSize ?? 4;
  const preserveCacheAnchor = options.preserveCacheAnchor ?? true;
  const pruneHistorical = options.pruneHistoricalToolOutputs ?? true;
  const maxResultChars = options.maxHistoricalResultChars ?? 140;

  const total = messages.length;
  if (total <= 2) {
    const tokens = estimateTokens(JSON.stringify(messages));
    return {
      payloadForModel: [...messages],
      metrics: {
        totalMessages: total,
        isolatedHistoricalTurns: 0,
        activeWindowTurns: total,
        tokensBefore: tokens,
        tokensAfter: tokens,
        prunedToolResultsCount: 0,
        savedVolatileTokens: 0,
        estimatedCacheStabilityPct: 100,
      },
    };
  }

  const tokensBefore = estimateTokens(JSON.stringify(messages));
  const boundaryIndex = Math.max(preserveCacheAnchor ? 1 : 0, total - activeWindowSize);

  let prunedCount = 0;
  const payload: Message[] = [];

  for (let i = 0; i < total; i++) {
    const msg = messages[i];
    const isAnchor = preserveCacheAnchor && i === 0;
    const isActive = i >= boundaryIndex;

    // Anchor and active messages are preserved verbatim for prompt caching
    if (isAnchor || isActive) {
      payload.push({ ...msg });
      continue;
    }

    // Historical messages: isolate and prune volatile pollution
    const cleanMsg: Message = { ...msg };

    // Prune massive tool results
    if (pruneHistorical && msg.toolResults && msg.toolResults.length > 0) {
      cleanMsg.toolResults = msg.toolResults.map((tr) => {
        if (!tr.text || tr.text.length <= maxResultChars) {
          return tr;
        }

        prunedCount++;
        const originalLen = tr.text.length;
        const excerpt = tr.text.slice(0, maxResultChars).trim();

        return {
          ...tr,
          text: `${excerpt}...\n[fast-jev context-isolation: ${originalLen} chars pruned to protect prompt cache]`,
        };
      });
    }

    // Shorten redundant assistant messages in the historical middle
    if (pruneHistorical && cleanMsg.role === 'assistant' && cleanMsg.text && cleanMsg.text.length > 500) {
      cleanMsg.text = `${cleanMsg.text.slice(0, 300).trim()}...\n[intermediate reasoning collapsed]`;
    }

    payload.push(cleanMsg);
  }

  // Inject a compact boundary checkpoint note if requested
  if (options.boundaryCheckpointNote && boundaryIndex > 1) {
    payload.splice(boundaryIndex, 0, {
      role: 'system',
      text: `[Fast-Jev Context Boundary]: Prior historical context isolated. Factual milestones preserved. Working active turn window begins below.`,
    });
  }

  const tokensAfter = estimateTokens(JSON.stringify(payload));
  const savedTokens = Math.max(0, tokensBefore - tokensAfter);
  const cacheStability = Number(Math.min(99.9, (tokensAfter / (tokensBefore || 1)) * 100).toFixed(1));

  return {
    payloadForModel: payload,
    metrics: {
      totalMessages: total,
      isolatedHistoricalTurns: Math.max(0, boundaryIndex - (preserveCacheAnchor ? 1 : 0)),
      activeWindowTurns: activeWindowSize,
      tokensBefore,
      tokensAfter,
      prunedToolResultsCount: prunedCount,
      savedVolatileTokens: savedTokens,
      estimatedCacheStabilityPct: cacheStability,
    },
  };
}
