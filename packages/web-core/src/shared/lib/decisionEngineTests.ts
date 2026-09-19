import {
  AdaptiveClassifier,
  AgentDecisionEngine,
  JevClassifier,
  LayaClassifier,
  evaluateDiffRules,
  type DecisionClassifier,
} from '@aurapunk/jev-plugin';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** Which model/engine answered (e.g. jev / laya / adaptive). */
  provider?: string;
  detail?: string;
  error?: string;
}

export type ClassifierPreference = 'auto' | 'jev' | 'laya';
export type AbideEngine = 'laya' | 'jev' | 'adaptive';

export interface EngineSettings {
  jevApiKey?: string;
  jevTypesafeUrl?: string;
  layaEndpoint?: string;
  layaHeaders?: Record<string, string>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the same classifier the app uses for a given preference. `auto` is Jev
 * with an automatic Laya fallback, exactly like the compactor.
 */
function buildClassifier(
  settings: EngineSettings,
  prefer: ClassifierPreference
): DecisionClassifier {
  if (prefer === 'jev') {
    return new JevClassifier({
      apiKey: settings.jevApiKey,
      typesafeUrl: settings.jevTypesafeUrl,
    });
  }
  if (prefer === 'laya') {
    return new LayaClassifier({
      endpoint: settings.layaEndpoint,
      headers: settings.layaHeaders,
      allowEmbeddedFallback: false,
    });
  }
  return new AdaptiveClassifier({
    apiKey: settings.jevApiKey,
    jevTypesafeUrl: settings.jevTypesafeUrl,
    layaEndpoint: settings.layaEndpoint,
    layaHeaders: settings.layaHeaders,
    allowEmbeddedFallback: false,
  });
}

const PROBE_STATE = 'Connection test from AuraPunk Settings.';
const PROBE_QUESTIONS = {
  probe: {
    type: 'noul' as const,
    instructions:
      'Return the calibrated probability that this is a reachable health check.',
  },
};

function describe(answer: unknown): string {
  const probability = (answer as { probability?: number } | undefined)
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
      return { ok: false, latencyMs: 0, error: 'Missing TypeSafe Jev API key' };
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
      error: message(error),
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
      error: message(error),
    };
  }
}

/**
 * Agent decisions (RLCD router): runs the 9 autonomous decisions on a sample
 * request through the configured model — the same engine the guardrails and
 * agent routing use.
 */
export async function testAgentDecisions(
  settings: EngineSettings,
  prefer: ClassifierPreference
): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const engine = new AgentDecisionEngine(buildClassifier(settings, prefer));
    const assessment = await engine.evaluateStep({
      userRequest: 'Fix the failing login test and run the test suite.',
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      provider: prefer,
      detail: `risk=${assessment.riskLevel.level} · tool=${assessment.toolChoice.tool} · confirm=${assessment.needsConfirmation.required}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      provider: prefer,
      error: message(error),
    };
  }
}

/**
 * Abide rule guardrails: evaluates a harmless sample diff through the
 * configured guardrail engine (deterministic, Jev semantic, or adaptive).
 */
export async function testAbideGuardrails(
  settings: EngineSettings,
  engine: AbideEngine
): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const result = await evaluateDiffRules({
      filePath: 'src/example.ts',
      diff: '@@ -0,0 +1 @@\n+const x = 1;',
      engine,
      jevApiKey: settings.jevApiKey,
      jevBaseUrl: settings.jevTypesafeUrl,
    });
    return {
      ok: true,
      latencyMs: result.latencyMs ?? Date.now() - started,
      provider: result.evaluatorUsed,
      detail: `allowed=${result.allowed} · violations=${result.violations.length}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      provider: engine,
      error: message(error),
    };
  }
}

/**
 * Memory extraction: asks the configured model the same durability question the
 * mem0 extraction path uses, confirming the model backing extraction answers.
 * (The extraction service itself runs on the server.)
 */
export async function testMemoryExtraction(
  settings: EngineSettings,
  prefer: ClassifierPreference
): Promise<ConnectionTestResult> {
  const started = Date.now();
  const fact = 'AuraPunk stores verified facts in mem0.';
  try {
    const classifier = buildClassifier(settings, prefer);
    const { answers, latencyMs } = await classifier.evaluateQuestions(fact, {
      durable: {
        type: 'noul',
        instructions:
          `Is this a durable, self-contained fact worth remembering long-term? ` +
          `Ignore transient logs and command output. Fact: "${fact}"`,
      },
    });
    return {
      ok: Boolean(answers.durable),
      latencyMs: latencyMs ?? Date.now() - started,
      provider: prefer,
      detail: describe(answers.durable),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      provider: prefer,
      error: message(error),
    };
  }
}
