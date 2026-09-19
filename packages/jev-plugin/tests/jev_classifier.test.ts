import { describe, expect, it, vi } from "vitest";
import {
  JevClassifier,
  TYPESAFE_JEV_DEFAULT_URL,
} from "../src/classifiers/jev_classifier.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as RequestInit };
    calls.push(call);
    return handler(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const QUESTIONS = {
  refunded: { type: "noul" as const, instructions: "Was a refund issued?" },
  team: {
    type: "choice" as const,
    instructions: "Which team?",
    criteria: { billing: "payments", support: "other" },
  },
  risk: {
    type: "score" as const,
    instructions: "How risky?",
    criteria: ["low", "medium", "high", "critical"],
  },
};

describe("JevClassifier (TypeSafe)", () => {
  it("posts to the TypeSafe endpoint and normalizes noul/choice/score", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          refunded: { type: "noul", noul: 0.96 },
          team: { type: "choice", choice: "billing", confidence: 1 },
          risk: { type: "score", score: 2.71, confidence: 0.71 },
        },
      })
    );
    const classifier = new JevClassifier({ apiKey: "ts_key", fetchFn: fn });
    const { answers } = await classifier.evaluateQuestions("state", QUESTIONS);

    expect(calls[0].url).toBe(TYPESAFE_JEV_DEFAULT_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ts_key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.questions.refunded.type).toBe("noul");
    expect(answers.refunded).toMatchObject({ type: "noul", verdict: true });
    expect(
      (answers.refunded as { probability: number }).probability
    ).toBeCloseTo(0.96);
    expect(answers.team).toMatchObject({ type: "choice", choice: "billing" });
    expect(answers.risk).toMatchObject({
      type: "score",
      levelIndex: 3,
      levelLabel: "critical",
    });
  });

  it("also normalizes a bare numeric noul answer", async () => {
    const { fn } = mockFetch(() =>
      jsonResponse({ answers: { refunded: 0.2 } })
    );
    const classifier = new JevClassifier({ apiKey: "ts_key", fetchFn: fn });
    const { answers } = await classifier.evaluateQuestions("state", {
      refunded: QUESTIONS.refunded,
    });
    expect(answers.refunded).toMatchObject({ type: "noul", verdict: false });
  });

  it("respects a custom endpoint", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ answers: {} }));
    const classifier = new JevClassifier({
      apiKey: "ts_key",
      typesafeUrl: "https://api.typesafe.ai/v1/other",
      fetchFn: fn,
    });
    await classifier.evaluateQuestions("state", {});
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/other");
  });

  it("throws a clear error when no TypeSafe key is configured", async () => {
    const { fn } = mockFetch(() => jsonResponse({ answers: {} }));
    const classifier = new JevClassifier({ fetchFn: fn });
    await expect(
      classifier.evaluateQuestions("state", QUESTIONS)
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});
