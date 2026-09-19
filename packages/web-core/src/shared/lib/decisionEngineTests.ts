import { JevClassifier, LayaClassifier } from '@aurapunk/jev-plugin';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** Which model answered (e.g. jev / laya). */
  provider?: string;
  detail?: string;
  error?: string;
}

const PROBE_STATE = 'Connection test from AuraPunk Settings.';
const PROBE_QUESTIONS = {
  probe: {
    type: 'noul' as const,
    instructions:
      'Return the calibrated probability that this is a reachable health check.',
  },
};

function describe(result: unknown): string {
  const probability = (result as { probability?: number } | undefined)
    ?.probability;
  return typeof probability === 'number'
    ? `answered (p=${probability.toFixed(2)})`
    : 'answered';
}

/** Test the official TypeSafe Jev API with the configured key/endpoint. */
export async function testJevConnection(options: {
  apiKey?: string;
  typesafeUrl?: string;
}): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const classifier = new JevClassifier({
      apiKey: options.apiKey,
      typesafeUrl: options.typesafeUrl,
    });
    if (!(await classifier.isAvailable())) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'Missing TypeSafe Jev API key',
      };
    }
    const { answers, latencyMs } = await classifier.evaluateQuestions(
      PROBE_STATE,
      PROBE_QUESTIONS
    );
    return {
      ok: Boolean(answers.probe),
      latencyMs: latencyMs ?? Date.now() - started,
      provider: 'jev',
      detail: describe(answers.probe),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      provider: 'jev',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Test a Laya endpoint (self-hosted Docker container or AuraPunk Cloud). */
export async function testLayaConnection(options: {
  endpoint?: string;
  headers?: Record<string, string>;
}): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    if (!options.endpoint) {
      return { ok: false, latencyMs: 0, error: 'No Laya endpoint configured' };
    }
    const classifier = new LayaClassifier({
      endpoint: options.endpoint,
      headers: options.headers,
      allowEmbeddedFallback: false,
    });
    const { answers, latencyMs } = await classifier.evaluateQuestions(
      PROBE_STATE,
      PROBE_QUESTIONS
    );
    return {
      ok: Boolean(answers.probe),
      latencyMs: latencyMs ?? Date.now() - started,
      provider: 'laya',
      detail: describe(answers.probe),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      provider: 'laya',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
