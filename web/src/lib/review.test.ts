import { describe, expect, it } from "vitest";
import {
  applyEdit,
  applyKeep,
  bulkKeepRemaining,
  clearReviewState,
  initReviewStates,
  nextPending,
  reduceReviewKey,
  reviewProgress,
} from "@/lib/review";
import type { CellKey } from "@/lib/types";

const q = (...n: number[]): CellKey[] => n.map((i) => `s${String(i).padStart(2, "0")}` as CellKey);

describe("initReviewStates", () => {
  it("キュー全件を pending で初期化する", () => {
    expect(initReviewStates(q(1, 2, 3))).toEqual({ s01: "pending", s02: "pending", s03: "pending" });
  });
});

describe("nextPending", () => {
  it("fromKey=null なら先頭の pending を返す", () => {
    expect(nextPending(q(1, 2, 3), initReviewStates(q(1, 2, 3)), null)).toBe("s01");
  });

  it("kept のセルは飛ばして次の pending を返す", () => {
    const states = { s01: "kept", s02: "pending", s03: "pending" } as const;
    expect(nextPending(q(1, 2, 3), states, "s01")).toBe("s02");
  });

  it("末尾から前方に未解決が無ければ先頭側へ回り込む", () => {
    const states = { s01: "pending", s02: "kept", s03: "kept" } as const;
    expect(nextPending(q(1, 2, 3), states, "s03")).toBe("s01");
  });

  it("pending が無ければ null", () => {
    const states = { s01: "kept", s02: "edited", s03: "kept" } as const;
    expect(nextPending(q(1, 2, 3), states, "s01")).toBeNull();
  });
});

describe("reviewProgress", () => {
  it("pending 以外を解決済みとして集計する", () => {
    const states = { s01: "kept", s02: "pending", s03: "edited", s04: "pending" } as const;
    expect(reviewProgress(q(1, 2, 3, 4), states)).toEqual({ resolved: 2, total: 4, percent: 50 });
  });

  it("空キューは 100%", () => {
    expect(reviewProgress([], {})).toEqual({ resolved: 0, total: 0, percent: 100 });
  });
});

describe("状態遷移 (immutable)", () => {
  it("applyKeep / applyEdit / clearReviewState は新オブジェクトを返す", () => {
    const base = initReviewStates(q(1, 2));
    const kept = applyKeep(base, "s01");
    expect(kept).not.toBe(base);
    expect(base.s01).toBe("pending");
    expect(kept.s01).toBe("kept");
    expect(applyEdit(base, "s02").s02).toBe("edited");
    expect(clearReviewState(kept, "s01").s01).toBe("pending");
  });
});

describe("bulkKeepRemaining", () => {
  it("pending を全て kept にし、edited はそのまま", () => {
    const states = { s01: "edited", s02: "pending", s03: "pending" } as const;
    expect(bulkKeepRemaining(q(1, 2, 3), states)).toEqual({ s01: "edited", s02: "kept", s03: "kept" });
  });
});

describe("reduceReviewKey", () => {
  it("矢印キーは move", () => {
    expect(reduceReviewKey("ArrowDown", { inInput: false })).toEqual({ type: "move", direction: 1 });
    expect(reduceReviewKey("ArrowUp", { inInput: false })).toEqual({ type: "move", direction: -1 });
  });

  it("Enter は keep（input内でも確定）", () => {
    expect(reduceReviewKey("Enter", { inInput: false })).toEqual({ type: "keep" });
    expect(reduceReviewKey("Enter", { inInput: true })).toEqual({ type: "keep" });
  });

  it("数字キーは input 外でのみ setValue", () => {
    expect(reduceReviewKey("3", { inInput: false })).toEqual({ type: "setValue", value: 3 });
    expect(reduceReviewKey("3", { inInput: true })).toEqual({ type: "none" });
  });

  it("Backspace は input 外でのみ clear", () => {
    expect(reduceReviewKey("Backspace", { inInput: false })).toEqual({ type: "clear" });
    expect(reduceReviewKey("Backspace", { inInput: true })).toEqual({ type: "none" });
  });

  it("その他キーは none", () => {
    expect(reduceReviewKey("a", { inInput: false })).toEqual({ type: "none" });
  });
});
