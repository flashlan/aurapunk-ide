import { compactMessages } from '../compactor/engine.js';
import { estimateTokens } from '../compactor/fitter.js';
import type { CompactionOptions, CompactionResult, Message, Role, ToolResult, ToolUse } from '../types.js';

export type SupportedFormat = 'openai' | 'anthropic' | 'universal' | 'aurapunk';

export interface UniversalCompactorOptions extends CompactionOptions {
  tokenThreshold?: number; // e.g. 50000 or 100000
  format?: SupportedFormat;
}

export interface UniversalCompactionOutput<T = any> {
  compacted: boolean;
  transcript: T;
  stats?: CompactionResult['stats'];
  decisions?: CompactionResult['decisions'];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Universal converters between popular LLM transcript formats and universal Message[]
 */
export class TranscriptConverter {
  /**
   * Convert OpenAI format ({ role, content, tool_calls, tool_call_id })
   */
  static fromOpenAI(items: any[]): Message[] {
    const messages: Message[] = [];
    for (const item of items) {
      const role: Role = item.role || 'user';
      const text = typeof item.content === 'string' ? item.content : '';

      const toolUses: ToolUse[] = [];
      if (item.tool_calls && Array.isArray(item.tool_calls)) {
        for (const tc of item.tool_calls) {
          toolUses.push({
            tool_use_id: tc.id,
            tool: tc.function?.name || 'unknown',
            input: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function?.arguments,
          });
        }
      }

      const toolResults: ToolResult[] = [];
      if (role === 'tool' && item.tool_call_id) {
        toolResults.push({
          tool_use_id: item.tool_call_id,
          text: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        });
      }

      messages.push({
        role,
        text: role !== 'tool' ? text : undefined,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      });
    }
    return messages;
  }

  static toOpenAI(messages: Message[]): any[] {
    const output: any[] = [];
    for (const m of messages) {
      if (m.toolResults && m.toolResults.length > 0) {
        for (const tr of m.toolResults) {
          output.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.text,
          });
        }
      }

      const toolCalls = m.toolUses?.map((u) => ({
        id: u.tool_use_id,
        type: 'function',
        function: {
          name: u.tool,
          arguments: typeof u.input === 'string' ? u.input : JSON.stringify(u.input),
        },
      }));

      if (m.text || (toolCalls && toolCalls.length > 0)) {
        output.push({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.text || '',
          tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    }
    return output;
  }

  /**
   * Convert Anthropic format (content blocks with type: 'text', 'tool_use', 'tool_result')
   */
  static fromAnthropic(items: any[]): Message[] {
    const messages: Message[] = [];
    for (const item of items) {
      const role: Role = item.role || 'user';
      let text = '';
      const toolUses: ToolUse[] = [];
      const toolResults: ToolResult[] = [];

      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        for (const block of item.content) {
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

      messages.push({
        role,
        text,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      });
    }
    return messages;
  }

  static toAnthropic(messages: Message[]): any[] {
    return messages.map((m) => {
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
}

/**
 * Universal Autocompactor for any LLM model transcript.
 */
export async function universalAutoCompact<T = any>(
  rawTranscript: T,
  options: UniversalCompactorOptions = {}
): Promise<UniversalCompactionOutput<T>> {
  const format = options.format || detectFormat(rawTranscript);
  let messages: Message[];

  switch (format) {
    case 'openai':
      messages = TranscriptConverter.fromOpenAI(rawTranscript as any[]);
      break;
    case 'anthropic':
      messages = TranscriptConverter.fromAnthropic(rawTranscript as any[]);
      break;
    default:
      messages = Array.isArray(rawTranscript) ? (rawTranscript as Message[]) : [];
      break;
  }

  const rawString = JSON.stringify(rawTranscript);
  const tokensBefore = estimateTokens(rawString);

  // Check token threshold
  if (options.tokenThreshold && tokensBefore < options.tokenThreshold) {
    return {
      compacted: false,
      transcript: rawTranscript,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  // Execute compaction
  const result = await compactMessages(messages, options);

  // Convert back to original format
  let compactedOutput: any;
  switch (format) {
    case 'openai':
      compactedOutput = TranscriptConverter.toOpenAI(result.messages);
      break;
    case 'anthropic':
      compactedOutput = TranscriptConverter.toAnthropic(result.messages);
      break;
    default:
      compactedOutput = result.messages;
      break;
  }

  const tokensAfter = estimateTokens(JSON.stringify(compactedOutput));

  return {
    compacted: result.stats.reductionRatio > 0.05,
    transcript: compactedOutput as T,
    stats: result.stats,
    decisions: result.decisions,
    tokensBefore,
    tokensAfter,
  };
}

function detectFormat(transcript: any): SupportedFormat {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return 'universal';
  }
  const first = transcript[0];
  if (first && (first.tool_calls || first.role === 'tool')) {
    return 'openai';
  }
  if (first && Array.isArray(first.content)) {
    const hasBlock = first.content.some((b: any) => b.type === 'tool_use' || b.type === 'tool_result');
    if (hasBlock) return 'anthropic';
  }
  return 'universal';
}
