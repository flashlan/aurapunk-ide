import type { DecisionAnswer, TypedQuestion } from "../types.js";
import type { DecisionClassifier } from "./interface.js";
import { JevClassifier } from "./jev_classifier.js";
import { LayaClassifier } from "./laya_classifier.js";

export interface AdaptiveClassifierOptions {
  apiKey?: string;
  jevBaseUrl?: string;
  vercelAiUrl?: string;
  vercelAiKey?: string;
  layaEndpoint?: string;
  pythonBridgePath?: string;
  fetchFn?: typeof fetch;
  preferProvider?: "auto" | "jev" | "laya";
}

export class AdaptiveClassifier implements DecisionClassifier {
  readonly providerName: "jev" | "laya" | "rule_fallback";
  private jev: JevClassifier;
  private laya: LayaClassifier;
  private preferProvider: "auto" | "jev" | "laya";
  private lastUsedProvider: "jev" | "laya" | "rule_fallback" = "laya";

  constructor(options: AdaptiveClassifierOptions = {}) {
    this.jev = new JevClassifier({
      apiKey: options.apiKey,
      baseUrl: options.jevBaseUrl,
      vercelAiUrl: options.vercelAiUrl,
      vercelAiKey: options.vercelAiKey,
      fetchFn: options.fetchFn,
    });
    this.laya = new LayaClassifier({
      endpoint: options.layaEndpoint,
      pythonBridgePath: options.pythonBridgePath,
      fetchFn: options.fetchFn,
    });
    this.preferProvider = options.preferProvider || "auto";
    this.providerName = "laya";
  }

  get activeProvider(): "jev" | "laya" | "rule_fallback" {
    return this.lastUsedProvider;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>,
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    // 1. If explicitly requested Laya, use Laya
    if (this.preferProvider === "laya") {
      this.lastUsedProvider = "laya";
      return this.laya.evaluateQuestions(state, questions);
    }

    // 2. If Jev is configured, try Jev first
    const jevAvailable = await this.jev.isAvailable();
    if (jevAvailable) {
      try {
        const result = await this.jev.evaluateQuestions(state, questions);
        this.lastUsedProvider = "jev";
        return result;
      } catch (err: any) {
        // Fallback to Laya with diagnostic note
        console.warn(
          `[AdaptiveClassifier] Jev evaluation failed (${err?.message || err}). Falling back to Laya System-1 classifier.`,
        );
      }
    }

    // 3. Fallback to Laya
    this.lastUsedProvider = "laya";
    return this.laya.evaluateQuestions(state, questions);
  }
}
