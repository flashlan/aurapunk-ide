import type { DecisionAnswer, TypedQuestion } from "../types.js";
import type { DecisionClassifier } from "./interface.js";

/** Default endpoint for Jev via the official TypeSafe API. */
export const TYPESAFE_JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
/**
 * Default endpoint for Jev through the Vercel AI Gateway. This is the
 * evaluation-model route the official AI SDK (`experimental_evaluate`) posts
 * to; the legacy `/v1/fast-jev` path never existed. See
 * https://vercel.com/docs/ai-gateway/modalities/evaluation
 */
export const VERCEL_JEV_DEFAULT_URL =
  "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
/** Gateway model id for TypeSafe's System One evaluation model. */
export const VERCEL_JEV_DEFAULT_MODEL = "typesafe-ai/jev";

/**
 * Transport selector for the Jev HTTP call. `"typesafe"` and the legacy
 * `"direct"` both target the official TypeSafe API; `"vercel-ai"` targets the
 * Vercel AI Gateway evaluation-model route. When omitted, the mode is inferred
 * from configured credentials (a Vercel key selects the gateway).
 */
export type JevTransportMode = "direct" | "typesafe" | "vercel-ai";

/**
 * Map the SDK question vocabulary onto the AI Gateway evaluation vocabulary:
 * the gateway calls the yes/no type `boolean`, TypeSafe calls it `noul`.
 */
function toGatewayQuestions(
  questions: Record<string, TypedQuestion>
): Record<string, Record<string, unknown>> {
  const mapped: Record<string, Record<string, unknown>> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      mapped[key] = { type: "boolean", instructions: q.instructions };
    } else if (q.type === "choice") {
      mapped[key] = {
        type: "choice",
        instructions: q.instructions,
        criteria: q.criteria,
      };
    } else {
      mapped[key] = {
        type: "score",
        instructions: q.instructions,
        criteria: q.criteria,
      };
    }
  }
  return mapped;
}

/** Normalize a single raw answer onto the `DecisionAnswer` contract. */
function normalizeAnswer(
  raw: unknown,
  question: TypedQuestion
): DecisionAnswer | null {
  const anyRaw = (raw ?? {}) as Record<string, unknown>;
  if (question.type === "noul") {
    const prob =
      typeof raw === "number"
        ? raw
        : ((anyRaw.probability as number) ?? (anyRaw.noul as number) ?? 0.5);
    const bounded = Math.max(0, Math.min(1, prob));
    return { type: "noul", probability: bounded, verdict: bounded >= 0.5 };
  }
  if (question.type === "choice") {
    const choice = (anyRaw.choice as string) ?? String(raw);
    const confidence = (anyRaw.confidence as number) ?? 0.85;
    const probabilities =
      (anyRaw.probabilities as Record<string, number>) ?? {
        [choice]: confidence,
      };
    return { type: "choice", choice, confidence, probabilities };
  }
  // score
  const score = typeof raw === "number" ? raw : ((anyRaw.score as number) ?? 0);
  const confidence = (anyRaw.confidence as number) ?? 0.85;
  const idx = Math.min(
    question.criteria.length - 1,
    Math.max(0, Math.round(score))
  );
  return {
    type: "score",
    score,
    levelIndex: idx,
    levelLabel: question.criteria[idx] || "unknown",
    confidence,
  };
}

export class JevClassifier implements DecisionClassifier {
  readonly providerName = "jev" as const;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private vercelAiUrl?: string;
  private vercelAiKey?: string;
  private mode: "direct" | "vercel-ai";
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(
    options: {
      apiKey?: string;
      baseUrl?: string;
      /** Explicit endpoint for the official TypeSafe Jev API. */
      typesafeUrl?: string;
      model?: string;
      vercelAiUrl?: string;
      vercelAiKey?: string;
      mode?: JevTransportMode;
      /** Request timeout in milliseconds (default 30s; Jev is a network call). */
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    } = {}
  ) {
    this.apiKey =
      options.apiKey ||
      (typeof process !== "undefined"
        ? process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_API_KEY
        : undefined);
    this.vercelAiKey =
      options.vercelAiKey ||
      (typeof process !== "undefined"
        ? process.env.AI_GATEWAY_API_KEY ||
          process.env.VERCEL_AI_KEY ||
          undefined
        : undefined);
    this.vercelAiUrl =
      options.vercelAiUrl ||
      (typeof process !== "undefined" ? process.env.VERCEL_AI_URL : undefined);
    this.mode = this.resolveMode(options.mode);
    this.baseUrl =
      this.mode === "vercel-ai"
        ? this.vercelAiUrl || VERCEL_JEV_DEFAULT_URL
        : options.typesafeUrl || options.baseUrl || TYPESAFE_JEV_DEFAULT_URL;
    this.model =
      options.model ||
      (this.mode === "vercel-ai"
        ? VERCEL_JEV_DEFAULT_MODEL
        : "jev-latest");
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchFn = options.fetchFn || fetch;
  }

  /**
   * Honor an explicit user selection; only infer from configured credentials
   * when no mode was requested. A bare gateway URL must NOT force the Vercel
   * transport — that would break TypeSafe-only setups — so inference keys off
   * the presence of a Vercel key.
   */
  private resolveMode(requested?: JevTransportMode): "direct" | "vercel-ai" {
    if (requested === "vercel-ai") return "vercel-ai";
    if (requested === "typesafe" || requested === "direct") return "direct";
    return this.vercelAiKey ? "vercel-ai" : "direct";
  }

  async isAvailable(): Promise<boolean> {
    const key =
      this.mode === "vercel-ai" ? this.vercelAiKey || this.apiKey : this.apiKey;
    return Boolean(key && key.trim().length > 0);
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    const effectiveKey =
      this.mode === "vercel-ai" ? this.vercelAiKey || this.apiKey : this.apiKey;
    if (!effectiveKey) {
      throw new Error(
        `JevClassifier: Missing ${
          this.mode === "vercel-ai" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY"
        }`
      );
    }

    const startTime = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveKey}`,
    };

    let body: Record<string, unknown>;
    if (this.mode === "vercel-ai") {
      // The gateway evaluation route carries the model id in a header and the
      // SDK vocabulary (`boolean` instead of `noul`).
      headers["ai-gateway-auth-method"] = "api-key";
      headers["ai-gateway-protocol-version"] = "0.0.1";
      headers["ai-evaluation-model-specification-version"] = "4";
      headers["ai-model-id"] = this.model;
      body = { state, questions: toGatewayQuestions(questions) };
    } else {
      body = { model: this.model, state, questions };
    }

    const response = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Jev API error HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, raw] of Object.entries(
      (data.answers || {}) as Record<string, unknown>
    )) {
      const question = questions[key];
      if (!question) continue;
      const normalized = normalizeAnswer(raw, question);
      if (normalized) answers[key] = normalized;
    }

    return { answers, latencyMs: Date.now() - startTime };
  }
}
