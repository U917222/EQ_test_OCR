import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupZipcode, normalizeZipcode } from "./zipcode";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeZipcode", () => {
  it("ハイフン・全角を除いた7桁を返す", () => {
    expect(normalizeZipcode("930-0000")).toBe("9300000");
    expect(normalizeZipcode("〒939-8201")).toBe("9398201");
  });

  it("7桁にならない入力は null", () => {
    expect(normalizeZipcode("930")).toBeNull();
    expect(normalizeZipcode("12345678")).toBeNull();
    expect(normalizeZipcode("")).toBeNull();
  });
});

describe("lookupZipcode", () => {
  it("zipcloudのaddress1/2/3を都道府県・市区町村・町域にマップする", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        results: [{ address1: "富山県", address2: "富山市", address3: "新総曲輪" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupZipcode("930-0094");

    expect(result).toEqual({ prefecture: "富山県", city: "富山市", town: "新総曲輪" });
    expect(fetchMock).toHaveBeenCalledWith("https://zipcloud.ibsnet.co.jp/api/search?zipcode=9300094");
  });

  it("形式不正なら通信せず null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupZipcode("930")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("該当なし(results=null)は null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 200, results: null }) }));
    expect(await lookupZipcode("0000000")).toBeNull();
  });

  it("通信失敗は null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await lookupZipcode("9300094")).toBeNull();
  });
});
