import type { IntegrationService } from 'shared/types';
import { makeRequest } from '@/shared/lib/api';

/** Fired after a local report so indicators refresh without waiting a poll. */
export const INTEGRATION_ERRORS_EVENT = 'integration-errors-changed';

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Record a failure of an external integration (Mem0, Laya, Jev) so the
 * sidebar indicator for that service shows it as a balloon.
 *
 * Never throws: reporting is the error path itself, and a failed report still
 * dispatches the local event so the indicator re-polls.
 */
export async function reportIntegrationError(
  service: IntegrationService,
  operation: string,
  error: unknown
): Promise<void> {
  const message = describeError(error);
  console.warn(`[${service}] ${operation} failed:`, error);
  try {
    await makeRequest('/api/integration-errors', {
      method: 'POST',
      body: JSON.stringify({ service, operation, message }),
    });
  } catch (reportError) {
    console.warn(
      `[${service}] could not report ${operation} failure:`,
      reportError
    );
  } finally {
    window.dispatchEvent(new Event(INTEGRATION_ERRORS_EVENT));
  }
}
