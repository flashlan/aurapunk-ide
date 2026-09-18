import type { DecisionAnswer, TypedQuestion } from '../types.js';
import type { DecisionClassifier } from './interface.js';

export class JevClassifier implements DecisionClassifier {
  readonly providerName = 'jev' as const;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private fetchFn: typeof fetch;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    fetchFn?: typeof fetch;
  } = {}) {
    this.apiKey = options.apiKey || (typeof process !== 'undefined' ? process.env.TYPESAFE_API_KEY : undefined);
    this.baseUrl = options.baseUrl || 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model || 'jev-latest';
    this.fetchFn = options.fetchFn || fetch;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    if (!this.apiKey) {
      throw new Error('JevClassifier: Missing TYPESAFE_API_KEY');
    }

    const startTime = Date.now();
    const response = await this.fetchFn(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        state,
        questions,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Jev API error HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const answers: Record<string, DecisionAnswer> = {};

    // Normalize response
    for (const [key, raw] of Object.entries(data.answers || {})) {
      const q = questions[key];
      if (!q) continue;

      if (q.type === 'noul') {
        const prob = typeof raw === 'number' ? raw : (raw as any)?.probability ?? (raw as any)?.noul ?? 0.5;
        answers[key] = {
          type: 'noul',
          probability: Math.max(0, Math.min(1, prob)),
          verdict: prob >= 0.5,
        };
      } else if (q.type === 'choice') {
        const choice = (raw as any)?.choice ?? String(raw);
        const confidence = (raw as any)?.confidence ?? 0.85;
        const probabilities = (raw as any)?.probabilities ?? { [choice]: confidence };
        answers[key] = {
          type: 'choice',
          choice,
          confidence,
          probabilities,
        };
      } else if (q.type === 'score') {
        const score = typeof raw === 'number' ? raw : (raw as any)?.score ?? 0;
        const confidence = (raw as any)?.confidence ?? 0.85;
        const idx = Math.min(q.criteria.length - 1, Math.max(0, Math.round(score)));
        answers[key] = {
          type: 'score',
          score,
          levelIndex: idx,
          levelLabel: q.criteria[idx] || 'unknown',
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
