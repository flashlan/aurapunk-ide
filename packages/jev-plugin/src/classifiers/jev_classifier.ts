import type { DecisionAnswer, TypedQuestion } from "../types.js";
import type { DecisionClassifier } from "./interface.js";

/**
 * Default endpoint for Jev via the official TypeSafe API. Jev is TypeSafe's
 * System One evaluation model; AuraPunk talks to it directly.
 */
export const TYPESAFE_JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * Transport selector kept for call-site clarity. Jev is only reached through
 * the official TypeSafe API, so both values map to the same endpoint.
 */
export type JevTransportMode = "direct" | "typesafe";

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
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(
    options: {
      apiKey?: string;
      baseUrl?: string;
      /** Explicit endpoint for the official TypeSafe Jev API. */
      typesafeUrl?: string;
      model?: string;
      /** Retained for call-site compatibility; Jev is TypeSafe-only. */
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
    this.baseUrl =
      options.typesafeUrl || options.baseUrl || TYPESAFE_JEV_DEFAULT_URL;
    this.model = options.model || "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 30000;
    // In WebKit (Tauri/Safari) `window.fetch` must be called with `window` as
    // its receiver; a detached reference throws
    // "Can only call Window.fetch on instances of Window". Bind it.
    this.fetchFn = options.fetchFn || fetch.bind(globalThis);
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    if (!this.apiKey) {
      throw new Error("JevClassifier: Missing TYPESAFE_API_KEY");
    }

    const startTime = Date.now();
    const response = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, state, questions }),
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
