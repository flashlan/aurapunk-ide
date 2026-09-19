import { AdaptiveClassifier } from '../classifiers/adaptive_classifier.js';
import type { DecisionClassifier } from '../classifiers/interface.js';
import type {
  CompactionOptions,
  CompactionResult,
  CompactionStats,
  Message,
  NoulQuestion,
  ToolCallDecision,
  ToolResult,
  ToolUse,
} from '../types.js';
import { estimateTokens, fitState } from './fitter.js';

export function calculateReductionRatio(beforeChars: number, afterChars: number): number {
  if (beforeChars <= 0) return 0;
  return Number(((beforeChars - afterChars) / beforeChars).toFixed(4));
}

function countTotalChars(messages: Message[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.text) count += m.text.length;
    if (m.toolUses) {
      for (const u of m.toolUses) {
        count += u.tool.length + u.tool_use_id.length;
        count += typeof u.input === 'string' ? u.input.length : JSON.stringify(u.input).length;
      }
    }
    if (m.toolResults) {
      for (const r of m.toolResults) {
        if (r.text) count += r.text.length;
      }
    }
  }
  return count;
}

/**
 * Main entrypoint for Fast Jev Context Compaction with Laya Fallback.
 * Works universally on any model transcript (OpenAI, Anthropic, Aurapunk).
 */
export async function compactMessages(
  messages: Message[],
  options: CompactionOptions = {},
  customClassifier?: DecisionClassifier
): Promise<CompactionResult> {
  const startTime = Date.now();
  const keepThreshold = options.keepThreshold ?? 0.5;
  const preserveRecent = options.preserveRecentMessages ?? 6;
  const truncateHeadChars = options.truncateHeadChars ?? 300;
  const maxStateTokens = options.maxStateTokens ?? 25000;

  const charsBefore = countTotalChars(messages);
  const estimatedTokensBefore = estimateTokens(
    messages.map((m) => (m.text || '') + JSON.stringify(m.toolUses || '') + JSON.stringify(m.toolResults || '')).join('\n')
  );

  // If too few messages, return verbatim
  if (messages.length <= 2) {
    return {
      messages: [...messages],
      decisions: [],
      stats: {
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        charsBefore,
        charsAfter: charsBefore,
        reductionRatio: 0,
        toolCallsTotal: 0,
        toolCallsKeptFull: 0,
        toolCallsTruncated: 0,
        toolCallsDropped: 0,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        providerUsed: 'rule_fallback',
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 1. Identify pinned messages (first message + newest preserveRecent)
  const totalMsgs = messages.length;
  const pinnedIndices = new Set<number>();
  pinnedIndices.add(0); // initial prompt/spec
  for (let i = Math.max(0, totalMsgs - preserveRecent); i < totalMsgs; i++) {
    pinnedIndices.add(i);
  }

  // 2. Pair tool uses with results
  const callMap = new Map<string, { call: ToolUse; msgIndex: number }>();
  const resultMap = new Map<string, { result: ToolResult; msgIndex: number }>();

  messages.forEach((msg, idx) => {
    if (msg.toolUses) {
      for (const u of msg.toolUses) {
        callMap.set(u.tool_use_id, { call: u, msgIndex: idx });
      }
    }
    if (msg.toolResults) {
      for (const r of msg.toolResults) {
        resultMap.set(r.tool_use_id, { result: r, msgIndex: idx });
      }
    }
  });

  // 3. Find candidates for decision (calls in non-pinned messages)
  const candidateCallIds: string[] = [];
  for (const [id, { msgIndex }] of callMap.entries()) {
    if (!pinnedIndices.has(msgIndex)) {
      candidateCallIds.push(id);
    }
  }

  // If no non-pinned tool calls exist, nothing to compact via Jev/Laya
  if (candidateCallIds.length === 0) {
    return {
      messages: [...messages],
      decisions: [],
      stats: {
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        charsBefore,
        charsAfter: charsBefore,
        reductionRatio: 0,
        toolCallsTotal: callMap.size,
        toolCallsKeptFull: callMap.size,
        toolCallsTruncated: 0,
        toolCallsDropped: 0,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        providerUsed: 'rule_fallback',
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 4. Fit state for classifier
  const fitted = fitState(messages, maxStateTokens, options.goal);

  // 5. Build questions for each candidate call
  const questions: Record<string, NoulQuestion> = {};
  for (const id of candidateCallIds) {
    const item = callMap.get(id)!;
    const toolName = item.call.tool;
    const inputStr = JSON.stringify(item.call.input).slice(0, 150);

    questions[`call_${id}`] = {
      type: 'noul',
      instructions: `Should the tool call stay in context history? Tool: ${toolName} with input: ${inputStr}. Knowing it was made matters for avoiding loops.`,
    };
    questions[`res_${id}`] = {
      type: 'noul',
      instructions: `Should the tool result stay verbatim in context history? Tool: ${toolName}. Retain verbatim only if exact content is still needed and re-running is harmful.`,
    };
  }

  // 6. Score questions via classifier (Jev -> Laya fallback)
  const classifier =
    customClassifier ||
    new AdaptiveClassifier({
      apiKey: options.apiKey,
      jevBaseUrl: options.jevBaseUrl,
      layaEndpoint: options.layaEndpoint,
      preferProvider: options.provider,
      fetchFn: options.fetchFn,
    });

  const evalResult = await classifier.evaluateQuestions(fitted.stateText, questions);
  const answers = evalResult.answers;
  const providerUsed = (classifier as any).activeProvider || classifier.providerName;

  // 7. Make decisions per candidate call
  const decisions: ToolCallDecision[] = [];
  let toolCallsKeptFull = 0;
  let toolCallsTruncated = 0;
  let toolCallsDropped = 0;

  for (const id of candidateCallIds) {
    const callItem = callMap.get(id)!;
    const callAnswer = answers[`call_${id}`];
    const resAnswer = answers[`res_${id}`];

    const keepCallProb = callAnswer && callAnswer.type === 'noul' ? callAnswer.probability : 0.6;
    const keepResProb = resAnswer && resAnswer.type === 'noul' ? resAnswer.probability : 0.3;

    let action: 'keep_full' | 'truncate_result' | 'drop_all';
    if (keepResProb >= keepThreshold) {
      action = 'keep_full';
      toolCallsKeptFull++;
    } else if (keepCallProb >= keepThreshold) {
      action = 'truncate_result';
      toolCallsTruncated++;
    } else {
      action = 'drop_all';
      toolCallsDropped++;
    }

    decisions.push({
      tool_use_id: id,
      tool: callItem.call.tool,
      keepCall: keepCallProb,
      keepResult: keepResProb,
      action,
    });
  }

  const decisionMap = new Map<string, ToolCallDecision>();
  for (const d of decisions) {
    decisionMap.set(d.tool_use_id, d);
  }

  // 8. Rebuild messages verbatim with decisions applied
  const newMessages: Message[] = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const isPinned = pinnedIndices.has(idx);

    if (isPinned) {
      // Pinned messages are preserved completely intact
      newMessages.push(msg);
      continue;
    }

    // Process tool uses
    const newToolUses: ToolUse[] = [];
    if (msg.toolUses) {
      for (const u of msg.toolUses) {
        const dec = decisionMap.get(u.tool_use_id);
        if (!dec || dec.action !== 'drop_all') {
          newToolUses.push(u);
        }
      }
    }

    // Process tool results
    const newToolResults: ToolResult[] = [];
    if (msg.toolResults) {
      for (const r of msg.toolResults) {
        const dec = decisionMap.get(r.tool_use_id);
        if (!dec || dec.action === 'keep_full') {
          newToolResults.push(r);
        } else if (dec.action === 'truncate_result') {
          const origLen = r.text ? r.text.length : 0;
          if (origLen > truncateHeadChars) {
            const head = r.text.slice(0, truncateHeadChars);
            const omitted = origLen - truncateHeadChars;
            newToolResults.push({
              ...r,
              text: `${head}\n[... fast-jev-compaction: ${omitted} chars truncated, output safely abridged ...]`,
            });
          } else {
            newToolResults.push(r);
          }
        }
        // If drop_all, neither call nor result is retained
      }
    }

    // Retain message only if it still contains text, toolUses, or toolResults
    const hasText = Boolean(msg.text && msg.text.trim().length > 0);
    const hasUses = newToolUses.length > 0;
    const hasResults = newToolResults.length > 0;

    if (hasText || hasUses || hasResults) {
      newMessages.push({
        ...msg,
        toolUses: hasUses ? newToolUses : undefined,
        toolResults: hasResults ? newToolResults : undefined,
      });
    }
  }

  const charsAfter = countTotalChars(newMessages);
  const estimatedTokensAfter = estimateTokens(
    newMessages.map((m) => (m.text || '') + JSON.stringify(m.toolUses || '') + JSON.stringify(m.toolResults || '')).join('\n')
  );

  const stats: CompactionStats = {
    messagesBefore: messages.length,
    messagesAfter: newMessages.length,
    charsBefore,
    charsAfter,
    reductionRatio: calculateReductionRatio(charsBefore, charsAfter),
    toolCallsTotal: candidateCallIds.length,
    toolCallsKeptFull,
    toolCallsTruncated,
    toolCallsDropped,
    estimatedTokensBefore,
    estimatedTokensAfter,
    providerUsed,
    durationMs: Date.now() - startTime,
  };

  return {
    messages: newMessages,
    decisions,
    stats,
  };
}
