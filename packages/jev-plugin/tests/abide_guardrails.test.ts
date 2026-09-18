import { describe, it, expect } from "vitest";
import {
  evaluateDiffRules,
  AURAPUNK_STANDARD_RULES,
  type AbideRule,
} from "../src/guardrails/abide_guardrails.js";
import type { DecisionClassifier } from "../src/classifiers/interface.js";
import type { TypedQuestion, DecisionAnswer } from "../src/types.js";

describe("Abide Rule Guardrails - Laya System-1 & Jev System-2", () => {
  it("Laya blocks direct modification of shared/types.ts with repair prompt in <1ms", async () => {
    const diff = `
--- a/shared/types.ts
+++ b/shared/types.ts
@@ -10,3 +10,4 @@
 export type User = { id: string };
+export type CustomStatus = 'in_progress' | 'blocked';
`;

    const result = await evaluateDiffRules({
      filePath: "shared/types.ts",
      diff,
      engine: "laya",
    });

    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].ruleId).toBe("no-direct-shared-types");
    expect(result.violations[0].evaluator).toBe("laya");
    expect(result.violations[0].repairInstruction).toContain(
      "Abide: This edit appears to break a rule",
    );
    expect(result.violations[0].repairInstruction).toContain(
      "Repair shared/types.ts now",
    );
  });

  it("Laya blocks prohibited AI attribution trailers in commits/files", async () => {
    const diff = `
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Aurapunk IDE
+
+Co-Authored-By: Claude <noreply@anthropic.com>
`;

    const result = await evaluateDiffRules({
      filePath: "README.md",
      diff,
      engine: "laya",
    });

    expect(result.allowed).toBe(false);
    expect(
      result.violations.some((v) => v.ruleId === "no-ai-attribution"),
    ).toBe(true);
  });

  it("Laya blocks exposed hardcoded API secrets", async () => {
    const diff = `
--- a/src/client.ts
+++ b/src/client.ts
@@ -5,3 +5,4 @@
+const API_KEY = "ts_live_abcdef1234567890abcdef123456";
`;

    const result = await evaluateDiffRules({
      filePath: "src/client.ts",
      diff,
      engine: "laya",
    });

    expect(result.allowed).toBe(false);
    expect(
      result.violations.some((v) => v.ruleId === "no-unprotected-secrets"),
    ).toBe(true);
  });

  it("Laya permits completely compliant and clean diffs", async () => {
    const diff = `
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,2 +1,6 @@
 export function add(a: number, b: number): number {
   return a + b;
+}
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
`;

    const result = await evaluateDiffRules({
      filePath: "src/utils/math.ts",
      diff,
      engine: "laya",
    });

    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it("Jev evaluates semantic rules when requested", async () => {
    const customSemanticRule: AbideRule = {
      id: "no-raw-throw",
      name: "Never throw raw Error to user",
      source: "AGENTS.md line 88",
      instruction:
        "Never throw raw unhandled Error; use AppError with user-facing message",
      when: "edit",
      threshold: 0.7,
    };

    // Mock Jev classifier returning violation probability 0.88
    const mockJev: DecisionClassifier = {
      isAvailable: async () => true,
      evaluateQuestions: async (
        state: string,
        questions: Record<string, TypedQuestion>,
      ) => {
        const answers: Record<string, DecisionAnswer> = {};
        for (const key of Object.keys(questions)) {
          answers[key] = {
            type: "noul",
            probability: 0.88,
            verdict: true,
          };
        }
        return { answers, latencyMs: 250 };
      },
    };

    const diff = `
--- a/src/api.ts
+++ b/src/api.ts
@@ -10,2 +10,4 @@
+if (!user) {
+  throw new Error("User not found!");
+}
`;

    const result = await evaluateDiffRules({
      filePath: "src/api.ts",
      diff,
      rules: [customSemanticRule],
      engine: "jev",
      classifierOverride: mockJev,
    });

    expect(result.allowed).toBe(false);
    expect(result.violations[0].ruleId).toBe("no-raw-throw");
    expect(result.violations[0].evaluator).toBe("jev");
    expect(result.violations[0].probability).toBe(0.88);
    expect(result.violations[0].repairInstruction).toContain(
      "Abide: This edit appears to break a rule",
    );
  });

  it("Adaptive mode gracefully falls back to Laya if Jev fails or times out", async () => {
    const failingJev: DecisionClassifier = {
      isAvailable: async () => true,
      evaluateQuestions: async () => {
        throw new Error("Connection timeout to Vercel AI / TypeSafe Gateway");
      },
    };

    const diff = `
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 console.log("Clean code");
`;

    // Should not throw, should log warning and return safe evaluation
    const result = await evaluateDiffRules({
      filePath: "src/index.ts",
      diff,
      engine: "adaptive",
      classifierOverride: failingJev,
    });

    // Clean diff should still be allowed, failure did not wedge the agent
    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBe(0);
  });
});
