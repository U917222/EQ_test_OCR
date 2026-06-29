import { describe, expect, it } from "vitest";
import {
  EVAL_ITEM_KEYS,
  EVAL_MAX_TOTAL,
  EVAL_SCORE_OPTIONS,
  summarize,
  totalScore,
} from "./evaluation";
import type { Evaluation, EvaluationItem, EvaluationItemKey } from "./types";

function items(scores: Partial<Record<EvaluationItemKey, number>>): EvaluationItem[] {
  return EVAL_ITEM_KEYS.map((key) => ({
    key,
    score: (scores[key] ?? 3) as EvaluationItem["score"],
    comment: "",
  }));
}

function evaluation(scores: Partial<Record<EvaluationItemKey, number>>, overrides: Partial<Evaluation> = {}): Evaluation {
  const its = items(scores);
  return {
    evaluationId: overrides.evaluationId ?? "e1",
    candidateId: "c1",
    evaluatorName: "面接官A",
    evalDate: "2026-06-24",
    jobRole: "",
    totalScore: totalScore(its),
    overallComment: "",
    items: its,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("score options", () => {
  it("offers 5..1 in descending order", () => {
    expect(EVAL_SCORE_OPTIONS.map((option) => option.value)).toEqual([5, 4, 3, 2, 1]);
  });

  it("has 6 items with a max total of 30", () => {
    expect(EVAL_ITEM_KEYS).toHaveLength(6);
    expect(EVAL_MAX_TOTAL).toBe(30);
  });
});

describe("totalScore", () => {
  it("sums all item scores", () => {
    expect(totalScore(items({}))).toBe(18); // 6 × 3
  });

  it("returns the max when every item is 5", () => {
    expect(totalScore(items({ knowledge: 5, adaptability: 5, personality: 5, interest: 5, potential: 5, aptitude: 5 }))).toBe(
      EVAL_MAX_TOTAL,
    );
  });

  it("ignores non-numeric scores", () => {
    expect(totalScore([{ score: Number.NaN }])).toBe(0);
  });
});

describe("summarize", () => {
  it("returns an empty summary with null averages for no evaluations", () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.averageTotal).toBeNull();
    expect(summary.itemAverages).toHaveLength(6);
    expect(summary.itemAverages.every((item) => item.average === null)).toBe(true);
  });

  it("averages totals and per-item scores across evaluators", () => {
    const summary = summarize([
      evaluation({ knowledge: 5, adaptability: 5, personality: 5, interest: 5, potential: 5, aptitude: 5 }), // total 30
      evaluation({ knowledge: 1, adaptability: 1, personality: 1, interest: 1, potential: 1, aptitude: 1 }, { evaluationId: "e2" }), // total 6
    ]);
    expect(summary.count).toBe(2);
    expect(summary.averageTotal).toBe(18); // (30 + 6) / 2
    const knowledge = summary.itemAverages.find((item) => item.key === "knowledge");
    expect(knowledge?.average).toBe(3); // (5 + 1) / 2
  });

  it("rounds averages to one decimal place", () => {
    const summary = summarize([
      evaluation({ knowledge: 5 }),
      evaluation({ knowledge: 4 }, { evaluationId: "e2" }),
      evaluation({ knowledge: 4 }, { evaluationId: "e3" }),
    ]);
    const knowledge = summary.itemAverages.find((item) => item.key === "knowledge");
    expect(knowledge?.average).toBe(4.3); // 13/3 = 4.333..
  });
});
