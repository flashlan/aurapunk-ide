import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import type { CompactorEngineType } from '@/shared/stores/useUiPreferencesStore';
import type { IntegrationService } from 'shared/types';

/**
 * Chat-side helpers for context compaction (ADR-052).
 *
 * The agent owns its context: each follow-up carries only the new message and
 * the agent resumes its own session (`--resume` / live terminal). Compaction
 * therefore means asking the agent to `/compact` its session; the chat only
 * records that it happened. Nothing is prepended to later prompts — repeating
 * a summary there would grow the agent's context instead of shrinking it.
 */

/**
 * Asks the agent for a handoff summary (`/summarize`, `/handoff`). The marker
 * must match `HANDOFF_SUMMARY_MARKER` in `crates/server/src/routes/sessions/
 * handoff.rs`: the backend hands this turn's answer to the next agent session
 * started in the workspace.
 */
export const HANDOFF_SUMMARY_PROMPT = [
  '[aurapunk:handoff-summary]',
  'Write a handoff summary of this session for the next agent that continues this workspace without your conversation. Answer only with the summary, in this order:',
  '1. Goal: what the task is and what "done" means.',
  '2. Done so far: what was changed and where (files, functions).',
  '3. Decisions: choices made and why, including approaches rejected.',
  '4. Open: what is left, known problems, and the next step.',
  '5. Pitfalls: anything that cost time and must not be repeated.',
  'Be specific and concise. Do not change any files.',
].join('\n');

/**
 * Laya runs only as a managed service: the self-hosted Docker container or the
 * hosted AuraPunk Cloud gateway. The embedded heuristic engine is never used as
 * a user-selected execution mode, so an unreachable endpoint surfaces instead
 * of silently "working locally" with no container running.
 */
export function resolveLayaEndpoint(
  layaMode: 'docker' | 'cloud' | undefined,
  layaDockerUrl?: string,
  layaCloudUrl?: string
): string | undefined {
  const url = layaMode === 'cloud' ? layaCloudUrl : layaDockerUrl;
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

/** Which integration a compaction failure belongs to, for error reporting. */
export function compactionService(
  engine: CompactorEngineType
): IntegrationService {
  return engine === 'jev' ? 'jev' : 'laya';
}

/**
 * Visual divider recording that the agent was asked to compact its own
 * context. `previousTokens` is the context size when it was requested.
 */
export function buildAgentCompactionMarker(
  previousTokens?: number | null
): PatchTypeWithKey {
  const size =
    previousTokens && previousTokens > 0
      ? ` (contexto em ~${previousTokens.toLocaleString()} tokens)`
      : '';
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `compaction-marker-${Date.now()}`,
    executionProcessId: 'session-compactor',
    content: {
      timestamp: new Date().toISOString(),
      entry_type: {
        type: 'compaction_marker',
        previous_tokens: previousTokens ?? null,
        compacted_tokens: null,
        mem0_synced: false,
      },
      content: [
        `### ✂ Contexto do agente compactado`,
        `O agente recebeu \`/compact\`${size} e resumiu a própria sessão. As próximas mensagens seguem normalmente pela sessão dele.`,
      ].join('\n\n'),
    },
  };
}

/**
 * Visible chat notice (rendered as an assistant message) used to report a
 * compaction that could not run — the manual `/compact` command used to fail
 * silently, so the user had no idea why the context never shrank.
 */
export function buildCompactionNotice(message: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `compaction-notice-${Date.now()}`,
    executionProcessId: 'session-compactor',
    content: {
      timestamp: new Date().toISOString(),
      entry_type: { type: 'assistant_message' },
      content: message,
    },
  };
}
