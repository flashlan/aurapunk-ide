import type { DecisionAnswer, TypedQuestion } from '../types.js';

export interface DecisionClassifier {
  readonly providerName: 'jev' | 'laya' | 'rule_fallback';
  isAvailable(): Promise<boolean>;
  evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }>;
}
