import { describe, expect, it } from "vitest";
import { areAllCellsEmpty } from "@/lib/cells";
import type { ScoreCell } from "@/lib/types";

function cell(value: number | null, detectedValue: number | null = null): ScoreCell {
  return {
    key: "s01",
    row: 1,
    col: 1,
    detectedValue,
    value,
    confidence: 1,
  };
}

describe("areAllCellsEmpty", () => {
  it("全セル空なら true", () => {
    expect(areAllCellsEmpty([cell(null), { ...cell(null), key: "s02" }])).toBe(true);
  });

  it("1つでも数値があれば false", () => {
    expect(areAllCellsEmpty([cell(null), { ...cell(2), key: "s02" }])).toBe(false);
  });
});
