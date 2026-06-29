import {
  CellKey,
  GetCellsResponse,
  GetResultResponse,
  ImageLinks,
  ScoreCell,
} from "@/lib/types";

const ITEM_LETTERS = "ABCDEFGHIJ";

type JsonRecord = Record<string, unknown>;

export function normalizeGetCellsResponse(raw: unknown): GetCellsResponse {
  const data = asRecord(raw);
  const reviewRows = Array.isArray(data.reviewQueue) ? data.reviewQueue : [];
  const reviewByCell = new Map<CellKey, JsonRecord>();

  for (const row of reviewRows) {
    const item = asRecord(row);
    const key = toCellKey(item.cell_key ?? item.cellKey ?? item.key);
    if (key) reviewByCell.set(key, item);
  }

  const cells = Array.isArray(data.cells)
    ? data.cells.map((cell, index) => normalizeCell(asRecord(cell), index, reviewByCell))
    : normalizeCellObject(asRecord(data.cells), reviewByCell);

  return {
    cells,
    reviewQueue: normalizeReviewQueue(data.reviewQueue, cells),
    imageLinks: normalizeImageLinks(data.imageLinks),
    cellImages: normalizeCellImages(data.imageLinks, data.cellImages),
  };
}

export function normalizeGetResultResponse(raw: unknown): GetResultResponse {
  const data = asRecord(raw) as GetResultResponse;
  if (!data.result) return data;

  return {
    ...data,
    result: {
      ...data.result,
      attitudeMinusPoints: Number(data.result.attitudeMinusPoints ?? 0),
      jobRequirementMinusPoints: Number(data.result.jobRequirementMinusPoints ?? 0),
      jobRequirementLowItems: Array.isArray(data.result.jobRequirementLowItems)
        ? data.result.jobRequirementLowItems
        : [],
      items: Array.isArray(data.result.items) ? data.result.items : [],
      crossCheck: Array.isArray(data.result.crossCheck) ? data.result.crossCheck : [],
    },
  };
}

function normalizeCellObject(cells: JsonRecord, reviewByCell: Map<CellKey, JsonRecord>): ScoreCell[] {
  return Object.keys(cells)
    .sort(compareCellKeys)
    .map((key, index) => {
      const cellKey = toCellKey(key) ?? (`s${String(index + 1).padStart(2, "0")}` as CellKey);
      return normalizeCell({ ...asRecord(cells[key]), key: cellKey }, index, reviewByCell);
    });
}

function normalizeCell(cell: JsonRecord, index: number, reviewByCell: Map<CellKey, JsonRecord>): ScoreCell {
  const key = toCellKey(cell.key ?? cell.cell_key ?? cell.cellKey) ?? (`s${String(index + 1).padStart(2, "0")}` as CellKey);
  const position = cellPosition(key);
  const review = reviewByCell.get(key);
  const corrected = review?.corrected_value ?? review?.correctedValue;
  const value = toNumberOrNull(corrected === "" || corrected === null || corrected === undefined ? cell.value : corrected);
  const detectedValue = toNumberOrNull(cell.detectedValue ?? cell.detected ?? review?.detected ?? cell.value);
  const confidence = toNumberOrNull(cell.confidence ?? review?.confidence) ?? (review ? 0.5 : 1);
  const resolved = typeof cell.resolved === "boolean"
    ? cell.resolved
    : !review || String(review.status ?? "OPEN").toUpperCase() === "RESOLVED";

  return {
    key,
    label: toStringOrUndefined(cell.label) ?? position.label,
    row: toNumberOrNull(cell.row) ?? position.row,
    col: toNumberOrNull(cell.col) ?? position.col,
    detectedValue,
    value,
    confidence,
    bbox: isRect(cell.bbox) ? cell.bbox : undefined,
    resolved,
  };
}

function normalizeReviewQueue(raw: unknown, cells: ScoreCell[]): CellKey[] {
  if (!Array.isArray(raw)) {
    return cells.filter((cell) => !cell.resolved).map((cell) => cell.key);
  }

  const keys = raw
    .map((item) => {
      const row = asRecord(item);
      return typeof item === "string" ? toCellKey(item) : toCellKey(row.cell_key ?? row.cellKey ?? row.key);
    })
    .filter((key): key is CellKey => Boolean(key));

  return keys.length ? keys : cells.filter((cell) => !cell.resolved).map((cell) => cell.key);
}

function normalizeImageLinks(raw: unknown): ImageLinks {
  const links = asRecord(raw);
  const preview = toStringOrUndefined(links.preview);
  const original = toStringOrUndefined(links.original);
  const mimeType = toStringOrUndefined(links.mimeType ?? links.contentType);
  const pages = Array.isArray(links.pages)
    ? links.pages.filter((page): page is string => typeof page === "string" && page.length > 0)
    : Object.entries(links)
      // mimeType/contentType と per-cell 切り抜き(sNN)はページ画像ではないので除外する
      .filter(([key]) => !["mimeType", "contentType"].includes(key) && !toCellKey(key))
      .map(([, page]) => page)
      .filter((page): page is string => typeof page === "string" && page.length > 0);

  return {
    preview: preview ?? pages[0],
    original: original ?? pages[0],
    pages,
    mimeType,
  };
}

// 実バックエンドは per-cell の手書き切り抜きを imageLinks の sNN キーに混ぜて返す。
// 一方、正規化済み(デモ等)のデータは top-level の cellImages に持つ。両方を統合して
// 取り出すことで、この関数は二度適用しても結果が変わらない(冪等)。
function normalizeCellImages(linksRaw: unknown, cellImagesRaw: unknown): Partial<Record<CellKey, string>> {
  const images: Partial<Record<CellKey, string>> = {};
  for (const source of [asRecord(linksRaw), asRecord(cellImagesRaw)]) {
    for (const [key, value] of Object.entries(source)) {
      const cellKey = toCellKey(key);
      if (cellKey && typeof value === "string" && value.length > 0) {
        images[cellKey] = value;
      }
    }
  }
  return images;
}

function cellPosition(key: CellKey) {
  const numeric = Number(key.slice(1));
  const index = Number.isFinite(numeric) ? Math.max(0, numeric - 1) : 0;
  const block = Math.floor(index / 40);
  const letterIndex = Math.floor((index % 40) / 4);
  const col = (index % 4) + 1;
  const row = block * 10 + letterIndex + 1;
  const letter = ITEM_LETTERS[letterIndex] ?? "?";
  return {
    row,
    col,
    label: `${letter}${block + 1}-${col}`,
  };
}

function compareCellKeys(a: string, b: string) {
  return Number(a.replace(/^s/, "")) - Number(b.replace(/^s/, ""));
}

function toCellKey(value: unknown): CellKey | null {
  const key = String(value ?? "").trim();
  return /^s\d{2}$/.test(key) ? (key as CellKey) : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function isRect(value: unknown): value is ScoreCell["bbox"] {
  const rect = asRecord(value);
  return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number");
}
