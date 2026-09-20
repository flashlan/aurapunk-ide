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
  useJevTypesafeUrl,
  readCloudAccessToken,
} from '@/shared/stores/useUiPreferencesStore';
import { executeSessionCompaction } from '../sessionCompactor';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown between automatic compactions
const HYSTERESIS_PCT = 10; // Must drop 10% below threshold before re-arming
const SCHEDULE_DELAY_MS = 1500; // Let the current render/stream settle before running
/**
 * Hard ceiling on a single compaction attempt. The classifiers already have
 * their own timeouts (Jev 30s, Laya 15s) and 'auto' can chain them, so this is
 * only a backstop: without it a wedged classifier call would hold the
 * in-flight latch forever and auto-compaction would never run again.
 */
const COMPACTION_TIMEOUT_MS = 120 * 1000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

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
  const jevTypesafeUrl = useJevTypesafeUrl();

  const lastCompactAtRef = useRef<Map<string, number>>(new Map());
  const armedRef = useRef<Map<string, boolean>>(new Map());
  const prevThresholdRef = useRef<string>(threshold);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest inputs for the deferred run. The effect re-runs on every streamed
  // patch, so the scheduled callback must read current values instead of the
  // closure captured at scheduling time.
  const latestRef = useRef({
    entries,
    engine,
    layaMode,
    layaDockerUrl,
    layaCloudUrl,
    jevApiKey,
    jevTypesafeUrl,
    isRunning,
  });
  latestRef.current = {
    entries,
    engine,
    layaMode,
    layaDockerUrl,
    layaCloudUrl,
    jevApiKey,
    jevTypesafeUrl,
    isRunning,
  };

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

        console.log(
          `[auto-compact] Token usage reached ${pct.toFixed(1)}% (threshold: ${thresholdPct}%). Executing compaction via ${latest.engine}...`
        );
        const token = readCloudAccessToken() ?? undefined;
        const run = (mode: 'docker' | 'cloud') =>
          executeSessionCompaction({
            entries: latest.entries,
            engine: latest.engine,
            layaMode: mode,
            layaDockerUrl: latest.layaDockerUrl,
            layaCloudUrl: latest.layaCloudUrl,
            layaAuthToken: token,
            jevApiKey: latest.jevApiKey,
            jevTypesafeUrl: latest.jevTypesafeUrl,
          });

        const result = await withTimeout(
          run(latest.layaMode).catch((firstErr) => {
            // Fall back to the hosted Laya gateway when this Desktop is signed in.
            if (token && latest.layaMode !== 'cloud') return run('cloud');
            throw firstErr;
          }),
          COMPACTION_TIMEOUT_MS,
          'auto-compaction'
        );

        // Inject marker into chat, appending to the latest entries rather than
        // the ones captured when this run was scheduled.
        setEntries([...latestRef.current.entries, result.markerPatch]);
        lastCompactAtRef.current.set(sessionId, Date.now());
      } catch (err) {
        console.warn('[auto-compact] Failed to execute auto-compaction:', err);
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
    layaMode,
    layaDockerUrl,
    layaCloudUrl,
    jevApiKey,
    jevTypesafeUrl,
  ]);
}
