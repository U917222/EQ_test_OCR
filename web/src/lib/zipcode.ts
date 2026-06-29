// 郵便番号→住所の補完。zipcloud の無料API（郵便番号のみ送信）を使う。
// https://zipcloud.ibsnet.co.jp/doc/api
const ZIPCLOUD_ENDPOINT = "https://zipcloud.ibsnet.co.jp/api/search";

export type ZipAddress = {
  prefecture: string;
  city: string;
  town: string;
};

type ZipcloudResult = {
  address1?: string;
  address2?: string;
  address3?: string;
};

type ZipcloudResponse = {
  status?: number;
  message?: string | null;
  results?: ZipcloudResult[] | null;
};

/** 入力から数字のみを取り出した7桁の郵便番号。形式が不正なら null。 */
export function normalizeZipcode(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, "");
  return digits.length === 7 ? digits : null;
}

export function mergeAutoTown(currentAddressLine: string, previousTown: string, nextTown: string): string {
  if (!nextTown) return currentAddressLine;
  if (!currentAddressLine) return nextTown;
  if (previousTown && currentAddressLine.startsWith(previousTown)) {
    return nextTown + currentAddressLine.slice(previousTown.length);
  }
  return currentAddressLine;
}

/**
 * 郵便番号から住所（都道府県・市区町村・町域）を引く。
 * 形式不正・該当なし・通信失敗はすべて null を返す（呼び出し側で手入力にフォールバック）。
 */
export async function lookupZipcode(input: string): Promise<ZipAddress | null> {
  const zipcode = normalizeZipcode(input);
  if (!zipcode) return null;

  let response: Response;
  try {
    response = await fetch(`${ZIPCLOUD_ENDPOINT}?zipcode=${zipcode}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const data = (await response.json().catch(() => null)) as ZipcloudResponse | null;
  const result = data?.results?.[0];
  if (!result) return null;

  return {
    prefecture: result.address1 ?? "",
    city: result.address2 ?? "",
    town: result.address3 ?? "",
  };
}
