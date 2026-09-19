import type { Message, ToolResult, ToolUse } from '../types.js';

/**
 * Fast calibrated token estimator.
 * Avoids heavy tokenizer dependencies while closely tracking
 * BPE tokenizer distributions (ModernBERT / Claude / GPT tokenizers).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Approximate: 1 token ~= 3.8 to 4 characters for English / code
  // Word boundaries, punctuation, and whitespace weighting
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  const digits = (text.match(/\d/g) || []).length;
  const symbols = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;

  const estimated = Math.ceil(words * 1.2 + digits * 0.5 + symbols * 0.8 + (chars - words * 5) * 0.1);
  return Math.max(1, Math.ceil(chars / 3.8), estimated);
}

/**
 * Creates a brief summary note for a tool result.
 */
export function formatToolResultSummary(result: ToolResult): string {
  const len = result.text ? result.text.length : 0;
  if (result.is_error) {
    const snippet = result.text ? result.text.slice(0, 120).replace(/\n/g, ' ') : 'error';
    return `error, ${len} chars: ${snippet}`;
  }
  return `ok, ${len} chars (omitted)`;
}

/**
 * Formats a single tool call for the classifier state.
 */
export function formatToolCall(call: ToolUse, inputMaxLen = 1000): string {
  let inputStr = typeof call.input === 'string' ? call.input : JSON.stringify(call.input);
  if (inputStr.length > inputMaxLen) {
    inputStr = inputStr.slice(0, inputMaxLen) + '...[truncated]';
  }
  return `Tool: ${call.tool} (id: ${call.tool_use_id}) input: ${inputStr}`;
}

export interface FittedState {
  stateText: string;
  tokenCount: number;
  stageReached: number;
}

/**
 * Progressively fits conversation history into maxStateTokens.
 * Never rewrites messages for the caller; this only formats the
 * representation shown to the Jev / Laya classifier.
 */
export function fitState(
  messages: Message[],
  maxTokens = 25000,
  goal?: string
): FittedState {
  // Stage 0: Initial clean state
  let stage = 0;
  let inputMaxLen = 1000;
  let textMaxLen = 10000;
  let compressOldTurns = false;

  for (stage = 0; stage <= 4; stage++) {
    if (stage === 1) inputMaxLen = 300;
    if (stage === 2) {
      inputMaxLen = 120;
      textMaxLen = 1500;
    }
    if (stage === 3) {
      inputMaxLen = 60;
      textMaxLen = 600;
      compressOldTurns = true;
    }
    if (stage === 4) {
      inputMaxLen = 40;
      textMaxLen = 300;
    }

    const lines: string[] = [];
    if (goal) {
      lines.push(`CURRENT GOAL: ${goal}`);
      lines.push('---');
    }

    const total = messages.length;
    messages.forEach((msg, idx) => {
      const isRecent = idx >= total - 4;
      const rolePrefix = msg.role.toUpperCase();

      // Text part
      let text = msg.text || '';
      if (!isRecent && compressOldTurns && text.length > textMaxLen) {
        const head = text.slice(0, Math.floor(textMaxLen / 2));
        const tail = text.slice(-Math.floor(textMaxLen / 2));
        text = `${head}\n[... ${text.length - textMaxLen} chars omitted ...]\n${tail}`;
      } else if (text.length > textMaxLen) {
        text = text.slice(0, textMaxLen) + '...[truncated]';
      }

      if (text.trim()) {
        lines.push(`${rolePrefix}: ${text}`);
      }

      // Tool uses
      if (msg.toolUses && msg.toolUses.length > 0) {
        for (const use of msg.toolUses) {
          lines.push(`  CALL: ${formatToolCall(use, inputMaxLen)}`);
        }
      }

      // Tool results
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const res of msg.toolResults) {
          lines.push(`  RESULT [${res.tool_use_id}]: ${formatToolResultSummary(res)}`);
        }
      }
    });

    const stateText = lines.join('\n');
    const tokenCount = estimateTokens(stateText);

    if (tokenCount <= maxTokens || stage === 4) {
      return {
        stateText,
        tokenCount,
        stageReached: stage,
      };
    }
  }

  // Fallback (guaranteed return)
  const finalState = messages.map(m => `${m.role}: ${m.text || ''}`).join('\n');
  return {
    stateText: finalState,
    tokenCount: estimateTokens(finalState),
    stageReached: 4,
  };
}
