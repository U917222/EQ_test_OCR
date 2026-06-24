// 採点レビュー(要確認セルの手直し)の純粋ロジック。UI から副作用を分離してテスト可能にする。
import type { CellKey } from "@/lib/types";

// セル単位のレビュー状態。
//  pending = 未確認 / kept = OCR推測値のまま確定 / edited = 手修正して確定
export type CellReviewState = "pending" | "kept" | "edited";

export type ReviewStates = Partial<Record<CellKey, CellReviewState>>;

export type ReviewKeyAction =
  | { type: "none" }
  | { type: "move"; direction: 1 | -1 }
  | { type: "setValue"; value: number }
  | { type: "keep" }
  | { type: "clear" };

export function initReviewStates(queue: CellKey[]): ReviewStates {
  const states: ReviewStates = {};
  for (const key of queue) states[key] = "pending";
  return states;
}

function stateOf(states: ReviewStates, key: CellKey): CellReviewState {
  return states[key] ?? "pending";
}

// order を fromKey の次から前方走査し、最初の pending を返す。末尾まで無ければ
// 先頭側へ回り込む。fromKey=null は先頭から。pending が無ければ null。
export function nextPending(order: CellKey[], states: ReviewStates, fromKey: CellKey | null): CellKey | null {
  if (order.length === 0) return null;
  const start = fromKey ? order.indexOf(fromKey) : -1;
  for (let step = 1; step <= order.length; step += 1) {
    const idx = (((start + step) % order.length) + order.length) % order.length;
    const key = order[idx];
    if (stateOf(states, key) === "pending") return key;
  }
  return null;
}

export function reviewProgress(order: CellKey[], states: ReviewStates): { resolved: number; total: number; percent: number } {
  const total = order.length;
  if (total === 0) return { resolved: 0, total: 0, percent: 100 };
  const resolved = order.reduce((count, key) => (stateOf(states, key) === "pending" ? count : count + 1), 0);
  return { resolved, total, percent: Math.round((resolved / total) * 100) };
}

function withState(states: ReviewStates, key: CellKey, next: CellReviewState): ReviewStates {
  return { ...states, [key]: next };
}

export function applyKeep(states: ReviewStates, key: CellKey): ReviewStates {
  return withState(states, key, "kept");
}

export function applyEdit(states: ReviewStates, key: CellKey): ReviewStates {
  return withState(states, key, "edited");
}

export function clearReviewState(states: ReviewStates, key: CellKey): ReviewStates {
  return withState(states, key, "pending");
}

// 残っている pending を全て kept にする(「残りはOCRのまま確定」)。edited は変えない。
export function bulkKeepRemaining(order: CellKey[], states: ReviewStates): ReviewStates {
  const next: ReviewStates = { ...states };
  for (const key of order) {
    if (stateOf(next, key) === "pending") next[key] = "kept";
  }
  return next;
}

// キー入力を「意図」に写像する。副作用(値の反映・カード移動)は呼び出し側が行う。
export function reduceReviewKey(key: string, opts: { inInput: boolean }): ReviewKeyAction {
  if (key === "ArrowDown") return { type: "move", direction: 1 };
  if (key === "ArrowUp") return { type: "move", direction: -1 };
  if (key === "Enter") return { type: "keep" };
  if (key === " " && !opts.inInput) return { type: "keep" };
  if (!opts.inInput && /^[0-9]$/.test(key)) return { type: "setValue", value: Number(key) };
  if ((key === "Backspace" || key === "Delete") && !opts.inInput) return { type: "clear" };
  return { type: "none" };
}
