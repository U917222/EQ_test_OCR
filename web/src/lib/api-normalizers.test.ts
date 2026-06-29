import { describe, expect, it } from "vitest";
import { normalizeGetCellsResponse } from "@/lib/api-normalizers";

describe("normalizeGetCellsResponse / cellImages", () => {
  it("imageLinks に混在する sNN の手書き切り抜きを cellImages に分離する", () => {
    const raw = {
      cells: {
        s01: { value: 2, flagged: false, reason: "" },
        s12: { value: "", flagged: true, reason: "low_confidence" },
      },
      reviewQueue: [
        {
          cell_key: "s12",
          detected: 2,
          confidence: 0.4,
          image_link: "data:image/png;base64,AAA",
          status: "OPEN",
          reason: "low_confidence",
        },
      ],
      imageLinks: {
        original: "https://drive.example/doc",
        preview: "https://drive.example/doc",
        pages: ["https://drive.example/doc"],
        mimeType: "application/pdf",
        s12: "data:image/png;base64,AAA",
      },
    };

    const result = normalizeGetCellsResponse(raw);

    expect(result.cellImages.s12).toBe("data:image/png;base64,AAA");
    // 文書ページ側に切り抜き data-URI が混入してはいけない
    expect(result.imageLinks.pages).toEqual(["https://drive.example/doc"]);
    expect(result.imageLinks.preview).toBe("https://drive.example/doc");
    expect(result.imageLinks.original).toBe("https://drive.example/doc");
  });

  it("pages 配列が無く sNN だけのとき、pages に切り抜きを混ぜず cellImages に入れる", () => {
    const raw = {
      cells: { s05: { value: "", flagged: true, reason: "low_confidence" } },
      reviewQueue: [{ cell_key: "s05", status: "OPEN" }],
      imageLinks: { s05: "data:image/png;base64,BBB" },
    };

    const result = normalizeGetCellsResponse(raw);

    expect(result.cellImages.s05).toBe("data:image/png;base64,BBB");
    expect(result.imageLinks.pages).toEqual([]);
    expect(result.imageLinks.preview).toBeUndefined();
  });

  it("正規化済みデータ(top-level cellImages)を再正規化しても保持する(冪等)", () => {
    const raw = {
      cells: [{ key: "s07", value: 1, detectedValue: 1, confidence: 0.5 }],
      reviewQueue: ["s07"],
      imageLinks: { preview: "https://drive.example/doc", pages: ["https://drive.example/doc"] },
      cellImages: { s07: "data:image/png;base64,CCC" },
    };

    const result = normalizeGetCellsResponse(raw);

    expect(result.cellImages.s07).toBe("data:image/png;base64,CCC");
    expect(result.imageLinks.pages).toEqual(["https://drive.example/doc"]);
  });

  it("切り抜きが無いときは cellImages は空オブジェクト", () => {
    const raw = {
      cells: { s01: { value: 1, flagged: false } },
      reviewQueue: [],
      imageLinks: { preview: "https://drive.example/doc", pages: ["https://drive.example/doc"] },
    };

    const result = normalizeGetCellsResponse(raw);

    expect(result.cellImages).toEqual({});
    expect(result.imageLinks.pages).toEqual(["https://drive.example/doc"]);
  });
});
