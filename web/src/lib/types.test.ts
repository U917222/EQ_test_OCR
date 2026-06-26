import { describe, expect, it } from "vitest";
import type { RegisterCandidatePayload } from "@/lib/types";

describe("RegisterCandidatePayload", () => {
  it("file を省いて登録ペイロードを構築できる", () => {
    const payload: RegisterCandidatePayload = {
      name: "山田 太郎",
      testDate: "2026-06-26",
      operationId: "op-test",
    };

    expect(payload).toEqual({
      name: "山田 太郎",
      testDate: "2026-06-26",
      operationId: "op-test",
    });
    expect("file" in payload).toBe(false);
  });
});
