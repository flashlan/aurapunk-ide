import { useEffect, useRef } from 'react';
import type { ExecutorConfig, TokenUsageInfo } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import {
  useCompactorEngine,
  useCompactionThreshold,
} from '@/shared/stores/useUiPreferencesStore';
import {
  buildAgentCompactionMarker,
  compactionService,
} from '../sessionCompactor';
import { reportIntegrationError } from '@/shared/lib/integrationErrors';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown between automatic compactions
const HYSTERESIS_PCT = 10; // Must drop 10% below threshold before re-arming
const SCHEDULE_DELAY_MS = 1500; // Let the current render/stream settle before running
/**
 * Cooldown/arming state deliberately lives at module scope, keyed by session.
 *
 * As `useRef` state it died with the component, so simply leaving the chat and
 * coming back (or switching workspace and returning) reset the cooldown — the
 * next visit compacted again immediately and injected a fresh "context
 * compacted" marker even though nothing had changed. Keeping it here means the
 * 5-minute cooldown and the re-arm hysteresis survive re-mounts.
 */
const lastCompactAtBySession = new Map<string, number>();
const armedBySession = new Map<string, boolean>();

export interface UseAutoCompactionOptions {
  sessionId?: string;
  tokenUsageInfo?: TokenUsageInfo | null;
  executorConfig?: ExecutorConfig | null;
  isRunning: boolean;
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  /**
   * Ask the agent to compact its own session (sends `/compact`) — the only
   * compaction that shrinks the context. Resolves to whether the request was
   * delivered. Without it (no session yet) nothing is compacted.
   */
  requestAgentCompaction?: () => Promise<boolean>;
}

function thresholdToNumber(t: string | null | undefined): number | null {
  if (!t || t === 'full') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Proactive Auto-Compaction Hook:
 * Monitors token usage against the configured threshold (e.g. 50%, 65%, 85%).
 * When exceeded and idle, asks the agent to `/compact` its session and records
 * a compaction marker in the chat (ADR-052). Nothing is added to later
 * prompts: the agent keeps its own (now compacted) context.
 */
export function useAutoCompaction({
  sessionId,
  tokenUsageInfo,
  executorConfig,
  isRunning,
  entries,
  setEntries,
  requestAgentCompaction,
}: UseAutoCompactionOptions): void {
  const requestAgentCompactionRef = useRef(requestAgentCompaction);
  requestAgentCompactionRef.current = requestAgentCompaction;
  const threshold = useCompactionThreshold();
  const engine = useCompactorEngine();

  // Backed by the module-scoped maps so the cooldown/arming survive re-mounts.
  const lastCompactAtRef = useRef(lastCompactAtBySession);
  const armedRef = useRef(armedBySession);
  const prevThresholdRef = useRef<string>(threshold);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest inputs for the deferred run. The effect re-runs on every streamed
  // patch, so the scheduled callback must read current values instead of the
  // closure captured at scheduling time.
  const latestRef = useRef({ entries, engine, isRunning, tokenUsageInfo });
  latestRef.current = { entries, engine, isRunning, tokenUsageInfo };

  // Unmount only: drop a pending (not yet started) compaction and release the
  // latch so a remount starts from a clean state.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      inFlightRef.current = false;
    },
    []
  );

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

    // Trigger compaction. The latch is released by `runCompaction`'s `finally`
    // below, or by the unmount cleanup if the scheduled run never starts.
    inFlightRef.current = true;
    armedRef.current.set(armedKey, false);

    const runCompaction = async () => {
      try {
        const latest = latestRef.current;
        // The agent may have resumed while we waited: never compact mid-stream.
        if (latest.isRunning) {
          armedRef.current.set(armedKey, true);
          return;
        }

        const requestAgent = requestAgentCompactionRef.current;
        if (!requestAgent) {
          armedRef.current.set(armedKey, true);
          return;
        }
        console.log(
          `[auto-compact] Token usage reached ${pct.toFixed(1)}% (threshold: ${thresholdPct}%). Asking the agent to /compact...`
        );
        const delivered = await requestAgent().catch(() => false);
        if (!delivered) {
          throw new Error(
            'the /compact request was not delivered to the agent'
          );
        }

        // Record it in the chat, appending to the latest entries rather than
        // the ones captured when this run was scheduled.
        setEntries([
          ...latestRef.current.entries,
          buildAgentCompactionMarker(
            latestRef.current.tokenUsageInfo?.total_tokens
          ),
        ]);
        lastCompactAtRef.current.set(sessionId, Date.now());
      } catch (err) {
        void reportIntegrationError(
          compactionService(latestRef.current.engine),
          'auto-compaction (asking the agent to /compact)',
          err
        );
        armedRef.current.set(armedKey, true);
      } finally {
        inFlightRef.current = false;
      }
    };

    // Deliberately NOT cleared by this effect's cleanup: the effect re-runs on
    // every streamed patch (entries/token usage), and cancelling the timer on
    // each of those would starve the scheduled run forever.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runCompaction();
    }, SCHEDULE_DELAY_MS);
  }, [
    sessionId,
    tokenUsageInfo,
    threshold,
    engine,
    isRunning,
    executorConfig,
    entries,
    setEntries,
  ]);
}
