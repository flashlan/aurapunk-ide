import { useCallback, useEffect, useState } from 'react';
import type {
  IntegrationError,
  IntegrationErrorsResponse,
  IntegrationService,
} from 'shared/types';
import { handleApiResponse, makeRequest } from '@/shared/lib/api';
import { INTEGRATION_ERRORS_EVENT } from '@/shared/lib/integrationErrors';

const POLL_INTERVAL_MS = 20_000;
/** Balloons show the most recent few; older ones are summarized as a count. */
const MAX_KEPT = 20;

/**
 * Highest `seq` the operator has dismissed, per indicator. Kept in memory on
 * purpose: the backend log restarts at seq 1 with the app, so a persisted
 * cursor would hide every error of the next run.
 */
const dismissedCursor = new Map<string, number>();

export interface IntegrationErrorsState {
  /** Undismissed errors for the requested services, newest last. */
  errors: IntegrationError[];
  /** Mark everything currently shown as seen. */
  dismiss: () => void;
}

/**
 * Failures recorded for the given integrations (see
 * `services::integration_errors`). Polls the in-memory backend log and
 * refreshes immediately on local reports.
 */
export function useIntegrationErrors(
  services: IntegrationService[]
): IntegrationErrorsState {
  const key = [...services].sort().join(',');
  const [errors, setErrors] = useState<IntegrationError[]>([]);

  const refresh = useCallback(async () => {
    const wanted = new Set(key.split(','));
    const cursor = dismissedCursor.get(key) ?? 0;
    try {
      const response = await makeRequest(
        `/api/integration-errors?after=${cursor}`,
        { cache: 'no-store' }
      );
      const data = await handleApiResponse<IntegrationErrorsResponse>(response);
      if (!data) return;
      const relevant = data.errors.filter((error) => wanted.has(error.service));
      setErrors(relevant.slice(-MAX_KEPT));
    } catch (error) {
      // The indicator is the error surface; if the backend itself is down
      // there is nothing to show here, and the health dots already say so.
      console.warn('[integration-errors] poll failed:', error);
    }
  }, [key]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onReport = () => void refresh();
    window.addEventListener(INTEGRATION_ERRORS_EVENT, onReport);
    return () => {
      clearInterval(timer);
      window.removeEventListener(INTEGRATION_ERRORS_EVENT, onReport);
    };
  }, [refresh]);

  const dismiss = useCallback(() => {
    setErrors((current) => {
      const last = current[current.length - 1];
      if (last) {
        dismissedCursor.set(
          key,
          Math.max(dismissedCursor.get(key) ?? 0, last.seq)
        );
      }
      return [];
    });
  }, [key]);

  return { errors, dismiss };
}
