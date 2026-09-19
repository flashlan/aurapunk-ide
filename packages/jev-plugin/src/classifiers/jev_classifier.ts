import type { DecisionAnswer, TypedQuestion } from "../types.js";
import type { DecisionClassifier } from "./interface.js";

/** Default endpoint for Jev via the official TypeSafe API. */
export const TYPESAFE_JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
/** Default endpoint for Fast Jev via the Vercel AI Gateway (beta alternative). */
export const VERCEL_JEV_DEFAULT_URL = "https://api.vercel.ai/v1/fast-jev";

/**
 * Transport selector for the Jev HTTP call. `"typesafe"` and the legacy
 * `"direct"` both target the official TypeSafe API; `"vercel-ai"` targets the
 * Vercel AI Gateway. When omitted, the mode is inferred from which key/URL is
 * configured (Vercel wins if present).
 */
export type JevTransportMode = "direct" | "typesafe" | "vercel-ai";

export class JevClassifier implements DecisionClassifier {
  readonly providerName = "jev" as const;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private vercelAiUrl?: string;
  private vercelAiKey?: string;
  private mode: "direct" | "vercel-ai";
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
      fetchFn?: typeof fetch;
    } = {},
  ) {
    this.apiKey =
      options.apiKey ||
      (typeof process !== "undefined"
        ? process.env.TYPESAFE_API_KEY
        : undefined);
    this.vercelAiKey =
      options.vercelAiKey ||
      (typeof process !== "undefined" ? process.env.VERCEL_AI_KEY : undefined);
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
      (this.mode === "vercel-ai" ? "fast-jev-v1" : "jev-latest");
    this.fetchFn = options.fetchFn || fetch;
  }

  /**
   * Honor an explicit user selection; only infer from configured credentials
   * when no mode was requested, so choosing "TypeSafe Direct" is never silently
   * overridden by a leftover Vercel key.
   */
  private resolveMode(requested?: JevTransportMode): "direct" | "vercel-ai" {
    if (requested === "vercel-ai") return "vercel-ai";
    if (requested === "typesafe" || requested === "direct") return "direct";
    return this.vercelAiKey || this.vercelAiUrl ? "vercel-ai" : "direct";
  }

  async isAvailable(): Promise<boolean> {
    const key =
      this.mode === "vercel-ai" ? this.vercelAiKey || this.apiKey : this.apiKey;
    return Boolean(key && key.trim().length > 0);
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>,
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    const effectiveKey =
      this.mode === "vercel-ai" ? this.vercelAiKey || this.apiKey : this.apiKey;
    if (!effectiveKey) {
      throw new Error(
        `JevClassifier: Missing ${this.mode === "vercel-ai" ? "VERCEL_AI_KEY" : "TYPESAFE_API_KEY"}`,
      );
    }

    const startTime = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveKey}`,
    };
    if (this.mode === "vercel-ai") {
      headers["x-vercel-ai-provider"] = "fast-jev";
    }

    const response = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        state,
        questions,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Jev API error HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const answers: Record<string, DecisionAnswer> = {};

    // Normalize response
    for (const [key, raw] of Object.entries(data.answers || {})) {
      const q = questions[key];
      if (!q) continue;

      if (q.type === "noul") {
        const prob =
          typeof raw === "number"
            ? raw
            : ((raw as any)?.probability ?? (raw as any)?.noul ?? 0.5);
        answers[key] = {
          type: "noul",
          probability: Math.max(0, Math.min(1, prob)),
          verdict: prob >= 0.5,
        };
      } else if (q.type === "choice") {
        const choice = (raw as any)?.choice ?? String(raw);
        const confidence = (raw as any)?.confidence ?? 0.85;
        const probabilities = (raw as any)?.probabilities ?? {
          [choice]: confidence,
        };
        answers[key] = {
          type: "choice",
          choice,
          confidence,
          probabilities,
        };
      } else if (q.type === "score") {
        const score =
          typeof raw === "number" ? raw : ((raw as any)?.score ?? 0);
        const confidence = (raw as any)?.confidence ?? 0.85;
        const idx = Math.min(
          q.criteria.length - 1,
          Math.max(0, Math.round(score)),
        );
        answers[key] = {
          type: "score",
          score,
          levelIndex: idx,
          levelLabel: q.criteria[idx] || "unknown",
          confidence,
        };
      }
    }

    return {
      answers,
      latencyMs: Date.now() - startTime,
    };
  }
}
