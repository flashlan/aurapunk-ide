import { useEffect, useRef } from 'react';
import type { ExecutorConfig, TokenUsageInfo } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import {
  useCompactorEngine,
  useCompactionThreshold,
  useLayaMode,
  useLayaDockerUrl,
  useLayaCloudUrl,
  useJevApiKey,
  useJevVercelUrl,
  useJevVercelKey,
  readCloudAccessToken,
} from '@/shared/stores/useUiPreferencesStore';
import { executeSessionCompaction } from '../sessionCompactor';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown between automatic compactions
const HYSTERESIS_PCT = 10; // Must drop 10% below threshold before re-arming

export interface UseAutoCompactionOptions {
  sessionId?: string;
  tokenUsageInfo?: TokenUsageInfo | null;
  executorConfig?: ExecutorConfig | null;
  isRunning: boolean;
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
}

function thresholdToNumber(t: string | null | undefined): number | null {
  if (!t || t === 'full') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Proactive Auto-Compaction Hook:
 * Monitors token usage against the configured threshold (e.g. 50%, 65%, 85%).
 * When exceeded and idle, triggers Fast Jev & Laya compaction, injecting
 * the compaction_marker into the chat and isolating past context.
 */
export function useAutoCompaction({
  sessionId,
  tokenUsageInfo,
  executorConfig,
  isRunning,
  entries,
  setEntries,
}: UseAutoCompactionOptions): void {
  const threshold = useCompactionThreshold();
  const engine = useCompactorEngine();
  const layaMode = useLayaMode();
  const layaDockerUrl = useLayaDockerUrl();
  const layaCloudUrl = useLayaCloudUrl();
  const jevApiKey = useJevApiKey();
  const jevVercelUrl = useJevVercelUrl();
  const jevVercelKey = useJevVercelKey();

  const lastCompactAtRef = useRef<Map<string, number>>(new Map());
  const armedRef = useRef<Map<string, boolean>>(new Map());
  const prevThresholdRef = useRef<string>(threshold);
  const inFlightRef = useRef(false);

  // Reset arming when threshold changes
  if (prevThresholdRef.current !== threshold) {
    prevThresholdRef.current = threshold;
    armedRef.current.clear();
  }

  useEffect(() => {
    if (engine === 'disabled') return;
    const thresholdPct = thresholdToNumber(threshold);
    if (thresholdPct == null) return;
    if (!sessionId) return;
    if (!executorConfig) return;
    if (!tokenUsageInfo) return;
    if (tokenUsageInfo.model_context_window <= 0) return;
    if (isRunning) return;
    if (inFlightRef.current) return;
    if (entries.length < 4) return;

    const effectiveTotal = tokenUsageInfo.total_tokens;
    if (effectiveTotal > tokenUsageInfo.model_context_window) return;

    const pct = (effectiveTotal / tokenUsageInfo.model_context_window) * 100;

    const armedKey = sessionId;
    const lastArmed = armedRef.current.get(armedKey);
    const armed = lastArmed !== undefined ? lastArmed : true;

    if (pct < thresholdPct - HYSTERESIS_PCT) {
      if (!armed) armedRef.current.set(armedKey, true);
      return;
    }

    if (!armed) return;
    if (pct < thresholdPct) return;

    // Cooldown check
    const lastAt = lastCompactAtRef.current.get(sessionId) ?? 0;
    if (Date.now() - lastAt < COOLDOWN_MS) return;

    // Trigger compaction
    inFlightRef.current = true;
    armedRef.current.set(armedKey, false);

    const runCompaction = async () => {
      try {
        console.log(
          `[auto-compact] Token usage reached ${pct.toFixed(1)}% (threshold: ${thresholdPct}%). Executing compaction via ${engine}...`
        );
        const { markerPatch } = await executeSessionCompaction({
          entries,
          engine,
          layaMode,
          layaDockerUrl,
          layaCloudUrl,
          layaAuthToken: readCloudAccessToken() ?? undefined,
          jevApiKey,
          jevVercelAiUrl: jevVercelUrl,
          jevVercelAiKey: jevVercelKey,
        });

        // Inject marker into chat
        setEntries([...entries, markerPatch]);
        lastCompactAtRef.current.set(sessionId, Date.now());
      } catch (err) {
        console.warn('[auto-compact] Failed to execute auto-compaction:', err);
        armedRef.current.set(armedKey, true);
      } finally {
        inFlightRef.current = false;
      }
    };

    const timer = setTimeout(() => void runCompaction(), 1500);
    return () => clearTimeout(timer);
  }, [
    sessionId,
    tokenUsageInfo,
    threshold,
    engine,
    isRunning,
    executorConfig,
    entries,
    setEntries,
    layaMode,
    layaDockerUrl,
    layaCloudUrl,
    jevApiKey,
  ]);
}
