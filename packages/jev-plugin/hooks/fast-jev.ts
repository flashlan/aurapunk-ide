/**
 * Claude Code Hook: session.compact
 * Replaces built-in lossy summary with Fast Jev Compaction (with Laya fallback).
 */

import { compactMessages } from '../src/compactor/engine.js';
import type { Message, ToolResult, ToolUse } from '../src/types.js';

export interface ClaudeCodeHookContext {
  messages: any[];
  env?: Record<string, string>;
  options?: {
    keepThreshold?: number;
    preserveRecentMessages?: number;
    truncateHeadChars?: number;
    maxStateTokens?: number;
    provider?: 'auto' | 'jev' | 'laya';
  };
}

export interface ClaudeCodeHookOutput {
  messages: any[];
  toast?: string;
  fallbackToDefault?: boolean;
}

/**
 * Normalizes Claude Code session messages to universal Message[]
 */
function toUniversalMessages(claudeMessages: any[]): Message[] {
  const result: Message[] = [];

  for (const m of claudeMessages) {
    const role = m.role || (m.type === 'user' ? 'user' : 'assistant');
    let text = '';
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];

    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') {
          text += (text ? '\n' : '') + block.text;
        } else if (block.type === 'tool_use') {
          toolUses.push({
            tool_use_id: block.id,
            tool: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          toolResults.push({
            tool_use_id: block.tool_use_id,
            text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            is_error: block.is_error,
          });
        }
      }
    }

    result.push({
      role,
      text: text || undefined,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    });
  }

  return result;
}

/**
 * Re-converts universal Message[] back to Claude Code content block format
 */
function fromUniversalMessages(universal: Message[]): any[] {
  return universal.map((m) => {
    const content: any[] = [];
    if (m.text) {
      content.push({ type: 'text', text: m.text });
    }
    if (m.toolUses) {
      for (const u of m.toolUses) {
        content.push({
          type: 'tool_use',
          id: u.tool_use_id,
          name: u.tool,
          input: u.input,
        });
      }
    }
    if (m.toolResults) {
      for (const r of m.toolResults) {
        content.push({
          type: 'tool_result',
          tool_use_id: r.tool_use_id,
          content: r.text,
          is_error: r.is_error,
        });
      }
    }
    return {
      role: m.role === 'tool' ? 'user' : m.role,
      content,
    };
  });
}

/**
 * Main Claude Code compaction hook function
 */
export async function handleSessionCompact(
  context: ClaudeCodeHookContext
): Promise<ClaudeCodeHookOutput> {
  try {
    const universalMsgs = toUniversalMessages(context.messages || []);
    const result = await compactMessages(universalMsgs, context.options || {});

    // If reduction was negligible (e.g. short session or no removable tool results)
    if (result.stats.reductionRatio < 0.15 && result.stats.toolCallsDropped === 0) {
      return {
        messages: context.messages,
        toast: `fast-jev-compaction: context already compact (${Math.round(result.stats.reductionRatio * 100)}% reduction)`,
        fallbackToDefault: true,
      };
    }

    const converted = fromUniversalMessages(result.messages);
    const pct = Math.round(result.stats.reductionRatio * 100);
    const provider = result.stats.providerUsed.toUpperCase();

    return {
      messages: converted,
      toast: `fast-jev-compaction (${provider}): kept ${result.stats.messagesAfter}/${result.stats.messagesBefore} messages (-${pct}% chars, no lossy summary)`,
    };
  } catch (error: any) {
    console.warn(`[fast-jev hook error] ${error?.message || error}. Falling back to default summary.`);
    return {
      messages: context.messages,
      toast: `fast-jev-compaction: fallback to default summary (${error?.message || 'error'})`,
      fallbackToDefault: true,
    };
  }
}

export default handleSessionCompact;
