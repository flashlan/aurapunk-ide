import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import type { NormalizedEntry } from 'shared/types';
import {
  compactMessages,
  isolateAndCompactContext,
  AdaptiveClassifier,
  JevClassifier,
  LayaClassifier,
  type Message,
} from '@aurapunk/jev-plugin';
import type { CompactorEngineType } from '@/shared/stores/useUiPreferencesStore';
import { jevProxyUrl } from '@/shared/lib/jevProxy';

/**
 * Normalizes UI conversation entries into universal Message[] for compaction.
 */
export function convertEntriesToMessages(
  entries: PatchTypeWithKey[]
): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.type !== 'NORMALIZED_ENTRY') continue;
    const content = entry.content;
    const entryType = content.entry_type;

    if (entryType.type === 'user_message') {
      messages.push({
        role: 'user',
        text: content.content,
      });
    } else if (entryType.type === 'assistant_message') {
      messages.push({
        role: 'assistant',
        text: content.content,
      });
    } else if (entryType.type === 'thinking') {
      messages.push({
        role: 'assistant',
        text: content.content,
      });
    } else if (entryType.type === 'tool_use') {
      messages.push({
        role: 'assistant',
        toolUses: [
          {
            tool: entryType.tool_name,
            tool_use_id: entry.patchKey,
            input: entryType.action_type,
          },
        ],
        toolResults: [
          {
            tool_use_id: entry.patchKey,
            text: content.content,
          },
        ],
      });
    } else if (entryType.type === 'system_message') {
      messages.push({
        role: 'system',
        text: content.content,
      });
    }
  }

  return messages;
}

/**
 * Finds the index of the latest compaction_marker in the entries array.
 * Returns -1 if no marker exists.
 */
export function findLatestCompactionMarkerIndex(
  entries: PatchTypeWithKey[]
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === 'NORMALIZED_ENTRY' &&
      entry.content.entry_type.type === 'compaction_marker'
    ) {
      return i;
    }
  }
  return -1;
}

export interface SlicedContextResult {
  marker: NormalizedEntry | null;
  activeEntries: PatchTypeWithKey[];
  isolatedEntriesCount: number;
  hasCompactedBoundary: boolean;
}

/**
 * Slices the conversation entries strictly from the last compaction marker downwards.
 * Everything above the marker is isolated and excluded from cloud model context.
 */
export function sliceEntriesFromLastMarker(
  entries: PatchTypeWithKey[]
): SlicedContextResult {
  const markerIndex = findLatestCompactionMarkerIndex(entries);

  if (markerIndex === -1) {
    return {
      marker: null,
      activeEntries: [...entries],
      isolatedEntriesCount: 0,
      hasCompactedBoundary: false,
    };
  }

  const markerEntry = entries[markerIndex];
  const marker =
    markerEntry.type === 'NORMALIZED_ENTRY' ? markerEntry.content : null;

  return {
    marker,
    activeEntries: entries.slice(markerIndex + 1),
    isolatedEntriesCount: markerIndex,
    hasCompactedBoundary: true,
  };
}

export interface ExecuteCompactionOptions {
  entries: PatchTypeWithKey[];
  engine: CompactorEngineType;
  layaDockerUrl?: string;
  layaCloudUrl?: string;
  /** Device bearer token for the hosted Cloud gateway (cloud mode only). */
  layaAuthToken?: string;
  jevApiKey?: string;
  /** Endpoint for the official TypeSafe Jev API. */
  jevTypesafeUrl?: string;
  layaMode?: 'docker' | 'cloud';
}

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

export interface CompactionExecutionResult {
  markerPatch: PatchTypeWithKey;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  reductionRatio: number;
  providerUsed: string;
}

/**
 * Executes context compaction using Fast Jev / Laya / Auto.
 * Produces a normalized CompactionMarker patch ready to be inserted into the chat.
 */
export async function executeSessionCompaction({
  entries,
  engine,
  layaDockerUrl,
  layaCloudUrl,
  layaAuthToken,
  jevApiKey,
  jevTypesafeUrl,
  layaMode,
}: ExecuteCompactionOptions): Promise<CompactionExecutionResult> {
  const universalMessages = convertEntriesToMessages(entries);
  const layaEndpoint = resolveLayaEndpoint(
    layaMode,
    layaDockerUrl,
    layaCloudUrl
  );
  // The hosted Cloud gateway authenticates every call with the device token;
  // the self-hosted Docker container needs no auth header.
  const layaHeaders =
    layaMode === 'cloud' && layaAuthToken
      ? { Authorization: `Bearer ${layaAuthToken}` }
      : undefined;
  // Jev goes through the local backend proxy: TypeSafe blocks browser CORS.
  const jevEndpoint = jevProxyUrl(jevTypesafeUrl);

  // Pick classifier based on user preferences in Settings
  let classifier;
  if (engine === 'laya') {
    classifier = new LayaClassifier({
      endpoint: layaEndpoint,
      headers: layaHeaders,
      allowEmbeddedFallback: false,
    });
  } else if (engine === 'jev') {
    classifier = new JevClassifier({
      apiKey: jevApiKey,
      typesafeUrl: jevEndpoint,
    });
  } else {
    // 'auto' or default fallback
    classifier = new AdaptiveClassifier({
      apiKey: jevApiKey,
      jevTypesafeUrl: jevEndpoint,
      layaEndpoint,
      layaHeaders,
      allowEmbeddedFallback: false,
    });
  }

  // Run compaction & isolation
  const result = await compactMessages(
    universalMessages,
    {
      preserveRecentMessages: 4,
      truncateHeadChars: 200,
      keepThreshold: 0.5,
    },
    classifier
  );

  const isolation = isolateAndCompactContext(result.messages, {
    activeWindowSize: 4,
    preserveCacheAnchor: true,
    pruneHistoricalToolOutputs: true,
    maxHistoricalResultChars: 160,
  });

  const tokensBefore = isolation.metrics.tokensBefore;
  const tokensAfter = isolation.metrics.tokensAfter;
  const reductionPct = Math.max(
    0,
    Math.round(((tokensBefore - tokensAfter) / (tokensBefore || 1)) * 100)
  );
  const provider = result.stats.providerUsed.toUpperCase();

  // Generate clean, readable markdown milestone
  const summary = [
    `### ✂ Contexto Compactado & Marco de Sessão`,
    `*Motor de Classificação: **${provider}** | Redução: **-${reductionPct}% tokens** (~${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()})*`,
    ``,
    `> **Fronteira Ativa:** O histórico anterior foi isolado. Logs gigantes de ferramentas, saídas antigas de terminal e raciocínios intermediários não serão mais reenviados ao modelo em nuvem.`,
    ``,
    `**Resumo dos Marcos Anteriores:**`,
    `- Total de mensagens consolidadas: ${result.stats.messagesBefore}`,
    `- Chamadas de ferramentas otimizadas: ${result.stats.toolCallsDropped + result.stats.toolCallsTruncated}`,
    `- Âncora do prompt inicial e janela recente mantidas verbatim (Prompt Caching 100% ativo).`,
    `- Memória indexada no Mem0 para recuperação semântica se necessário via \`memory_search\`.`,
  ].join('\n');

  const markerPatch: PatchTypeWithKey = {
    type: 'NORMALIZED_ENTRY',
    patchKey: `compaction-marker-${Date.now()}`,
    executionProcessId: 'session-compactor',
    content: {
      timestamp: new Date().toISOString(),
      entry_type: {
        type: 'compaction_marker',
        previous_tokens: tokensBefore,
        compacted_tokens: tokensAfter,
        mem0_synced: true,
      },
      content: summary,
    },
  };

  return {
    markerPatch,
    summary,
    tokensBefore,
    tokensAfter,
    reductionRatio: result.stats.reductionRatio,
    providerUsed: provider,
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

/**
 * Formats a prompt payload isolating historical noise above the last compaction marker.
 */
export function prepareCloudPromptWithIsolation(
  prompt: string,
  entries: PatchTypeWithKey[]
): string {
  const { marker, activeEntries, hasCompactedBoundary } =
    sliceEntriesFromLastMarker(entries);

  if (!hasCompactedBoundary || !marker) {
    return prompt;
  }

  // Format the condensed active window turns below the marker
  const activeTurnsText = activeEntries
    .filter((e) => e.type === 'NORMALIZED_ENTRY')
    .slice(-4)
    .map((e) => {
      if (e.type !== 'NORMALIZED_ENTRY') return '';
      const t = e.content.entry_type.type;
      const role =
        t === 'user_message'
          ? 'Usuário'
          : t === 'assistant_message'
            ? 'Assistente'
            : 'Sistema';
      return `${role}: ${e.content.content.slice(0, 300)}`;
    })
    .filter(Boolean)
    .join('\n');

  return [
    `[Contexto Consolidado da Sessão Anterior (Marco de Compactação)]`,
    marker.content,
    ``,
    activeTurnsText
      ? `[Turnos Recentes da Janela Ativa]:\n${activeTurnsText}\n`
      : '',
    `---`,
    `Instrução do Usuário:`,
    prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}
