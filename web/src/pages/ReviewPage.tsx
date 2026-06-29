import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  ImageOff,
  Loader2,
  Save,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeGetCellsResponse } from "@/lib/api-normalizers";
import { useAuth } from "@/lib/auth";
import { areAllCellsEmpty } from "@/lib/cells";
import { confidenceTone } from "@/lib/labels";
import { isApiError, postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import {
  applyEdit,
  applyKeep,
  bulkKeepRemaining,
  clearReviewState,
  nextPending,
  reduceReviewKey,
  reviewProgress,
  type CellReviewState,
  type ReviewStates,
} from "@/lib/review";
import { CellKey, SaveCellsPayload, ScoreCell } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ReviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<CellKey | null>(null);
  const [edited, setEdited] = useState<Record<CellKey, number | null>>({});
  const [states, setStates] = useState<ReviewStates>({});
  const [showAllCells, setShowAllCells] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [pageIdx, setPageIdx] = useState(0);
  const [zoom, setZoom] = useState(1);

  const query = useQuery({
    queryKey: ["cells", id],
    queryFn: async () =>
      normalizeGetCellsResponse(await postApi<{ candidateId: string }, unknown>("getCells", { candidateId: id })),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (query.error) toast.error("レビュー対象セルを取得できませんでした");
  }, [query.error]);

  useEffect(() => {
    if (!query.data) return;
    const { cells: loadedCells, reviewQueue, cellImages } = query.data;
    setEdited(
      Object.fromEntries(loadedCells.map((cell) => [cell.key, cell.value ?? cell.detectedValue ?? null])) as Record<
        CellKey,
        number | null
      >,
    );
    const initialStates: ReviewStates = {};
    for (const cell of loadedCells) initialStates[cell.key] = cell.resolved ? "kept" : "pending";
    for (const key of reviewQueue) initialStates[key] = "pending";
    setStates(initialStates);
    setActiveKey(reviewQueue[0] ?? loadedCells[0]?.key ?? null);
    // 切り抜き画像が1枚も無いとき(手入力経路など)は参照用紙を最初から開く
    setShowReference(!reviewQueue.some((key) => cellImages[key]));
    setPageIdx(0);
    // クリック前でもキーボード操作が効くようコンテナへフォーカスを当てる
    requestAnimationFrame(() => containerRef.current?.focus());
  }, [query.data]);

  const cells = query.data?.cells ?? [];
  const queue = query.data?.reviewQueue ?? [];
  const cellImages = query.data?.cellImages ?? {};
  const imageLinks = query.data?.imageLinks ?? {};

  const cellByKey = useMemo(() => new Map(cells.map((cell) => [cell.key, cell])), [cells]);
  const allKeys = useMemo(
    () => [...cells].map((cell) => cell.key).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    [cells],
  );
  const orderKeys = showAllCells ? allKeys : queue;
  const progress = reviewProgress(queue, states);
  const allCellsEmpty = areAllCellsEmpty(cells, edited);

  // 数字ボタンの候補値: 実データの検出値から導出し、基本の 0〜3 を必ず含める。
  const quickValues = useMemo(() => {
    const values = new Set<number>([0, 1, 2, 3]);
    for (const cell of cells) {
      if (typeof cell.detectedValue === "number") values.add(cell.detectedValue);
      if (typeof cell.value === "number") values.add(cell.value);
    }
    return Array.from(values)
      .filter((value) => value >= 0 && value <= 9)
      .sort((a, b) => a - b);
  }, [cells]);

  const buildPayloadCells = () =>
    cells.reduce<Record<CellKey, number | null>>((acc, cell) => {
      acc[cell.key] = edited[cell.key] ?? null;
      return acc;
    }, {});

  const saveMutation = useMutation({
    mutationFn: (payload: SaveCellsPayload) => postApi<SaveCellsPayload, { saved: true }>("saveCells", payload),
    onSuccess: () => {
      toast.success("セルを保存しました");
      queryClient.invalidateQueries({ queryKey: ["cells", id] });
    },
    onError: () => toast.error("セルを保存できませんでした"),
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      await postApi<SaveCellsPayload, { saved: true }>("saveCells", {
        candidateId: id,
        cells: buildPayloadCells(),
        operationId: newOperationId(),
      });
      return postApi<{ candidateId: string; operationId: string }, { result: unknown }>("finalize", {
        candidateId: id,
        operationId: newOperationId(),
      });
    },
    onSuccess: () => {
      toast.success("採点を確定しました");
      navigate(`/candidates/${id}/result`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : "採点を確定できませんでした"),
  });

  const advance = (fromKey: CellKey, nextStates: ReviewStates) => {
    setActiveKey(nextPending(orderKeys, nextStates, fromKey) ?? fromKey);
  };

  const keepCell = (key: CellKey) => {
    const nextStates = applyKeep(states, key);
    setStates(nextStates);
    advance(key, nextStates);
  };

  const pickValue = (key: CellKey, value: number) => {
    setEdited((current) => ({ ...current, [key]: value }));
    const nextStates = applyEdit(states, key);
    setStates(nextStates);
    advance(key, nextStates);
  };

  // 数値入力(直接タイプ)は値だけ反映し、カードは進めない。
  const editValue = (key: CellKey, value: number | null) => {
    setEdited((current) => ({ ...current, [key]: value }));
    setStates((current) => (value === null ? clearReviewState(current, key) : applyEdit(current, key)));
  };

  const clearCell = (key: CellKey) => {
    setEdited((current) => ({ ...current, [key]: null }));
    setStates((current) => clearReviewState(current, key));
  };

  const move = (direction: 1 | -1) => {
    if (!activeKey || orderKeys.length === 0) return;
    const index = orderKeys.indexOf(activeKey);
    if (index < 0) {
      setActiveKey(orderKeys[0]);
      return;
    }
    const next = Math.min(Math.max(index + direction, 0), orderKeys.length - 1);
    setActiveKey(orderKeys[next]);
  };

  const keepRemaining = () => {
    const nextStates = bulkKeepRemaining(queue, states);
    setStates(nextStates);
    toast.success("残りの要確認セルをOCRのまま確定にしました");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!activeKey) return;
    const inInput = event.target instanceof HTMLElement && event.target.tagName === "INPUT";
    const action = reduceReviewKey(event.key, { inInput });
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "move") move(action.direction);
    else if (action.type === "keep") keepCell(activeKey);
    else if (action.type === "setValue") pickValue(activeKey, action.value);
    else if (action.type === "clear") clearCell(activeKey);
  };

  const save = () => {
    saveMutation.mutate({
      candidateId: id,
      cells: buildPayloadCells(),
      operationId: newOperationId(),
    });
  };

  const finalize = () => {
    if (allCellsEmpty) {
      toast.error("テスト結果が未入力です。先に採点用紙のアップロードまたはセル入力を行ってください。");
      return;
    }
    finalizeMutation.mutate();
  };

  if (query.isLoading) {
    return (
      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Skeleton className="h-[640px]" />
        <Skeleton className="h-[640px]" />
      </div>
    );
  }

  if (!cells.length) {
    return (
      <Card>
        <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
          <h1 className="text-lg font-semibold">レビュー対象セルがありません</h1>
          <p className="mt-2 text-sm text-slate-600">OCR処理が完了すると確認セルが表示されます。</p>
          <Button asChild className="mt-5" variant="outline">
            <Link to="/candidates">候補者一覧へ</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pages = imageLinks.pages?.length ? imageLinks.pages : [imageLinks.preview ?? imageLinks.original].filter(Boolean) as string[];
  const currentDoc = pages[pageIdx] ?? pages[0];
  const docIsPdf = isPdfDocument(imageLinks.mimeType, currentDoc);
  const allDone = progress.total > 0 && progress.resolved >= progress.total;
  const canFinalize = can("reviewer") && !allCellsEmpty;

  return (
    <div ref={containerRef} className="space-y-5 outline-none" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">採点レビュー</h1>
          <p className="mt-1 text-sm text-slate-600">
            手書きの切り抜きを見ながら、要確認セルを1枚ずつ確認・修正します。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to={`/candidates/${id}/result`}>
              <ArrowLeft className="h-4 w-4" />
              結果へ戻る
            </Link>
          </Button>
          <Button variant="outline" onClick={save} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            変更を保存
          </Button>
          <Button
            onClick={finalize}
            disabled={!canFinalize || finalizeMutation.isPending}
            title={
              !can("reviewer")
                ? "reviewer以上のみ確定できます"
                : allCellsEmpty
                  ? "テスト結果を入力してから確定してください"
                  : undefined
            }
          >
            {finalizeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            採点を確定
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {allDone ? "要確認セルはすべて確認済みです" : `要確認 残り ${progress.total - progress.resolved} 件`}
                <span className="ml-2 text-slate-500">
                  ({progress.resolved} / {progress.total})
                </span>
              </span>
              <span className="hidden text-xs text-slate-500 sm:inline">
                数字キー=修正して次へ / Enter=このままOK / ↑↓=移動
              </span>
            </div>
            <Progress value={progress.percent} className="mt-3" />
          </div>
          <Button
            variant="outline"
            onClick={keepRemaining}
            disabled={allDone || progress.total === 0}
            className="shrink-0"
          >
            <Check className="h-4 w-4" />
            残りはOCRのまま確定
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">
          {showAllCells ? "全80セル" : "要確認セル"}
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setShowAllCells((value) => !value)}>
          {showAllCells ? "要確認だけ表示" : "全セルを表示"}
        </Button>
      </div>

      {orderKeys.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-40 flex-col items-center justify-center p-6 text-center text-sm text-slate-600">
            {allCellsEmpty
              ? "採点セルが未入力です。全セルを表示して数値を入力してください。"
              : "要確認セルはありません。そのまま採点を確定できます。"}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {orderKeys.map((key) => {
            const cell = cellByKey.get(key);
            if (!cell) return null;
            return (
              <CellReviewCard
                key={key}
                cell={cell}
                state={states[key] ?? "pending"}
                value={edited[key] ?? null}
                cropUrl={cellImages[key]}
                quickValues={quickValues}
                active={key === activeKey}
                onActivate={() => setActiveKey(key)}
                onKeep={() => keepCell(key)}
                onPick={(value) => pickValue(key, value)}
                onEdit={(value) => editValue(key, value)}
                onOpenReference={() => {
                  setShowReference(true);
                  setActiveKey(key);
                }}
              />
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-slate-500" />
            採点用紙(参照)
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setShowReference((value) => !value)}>
            {showReference ? "閉じる" : "開く"}
          </Button>
        </CardHeader>
        {showReference ? (
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              {pages.length > 1 ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPageIdx((value) => Math.max(0, value - 1))}
                    disabled={pageIdx === 0}
                    aria-label="前のページ"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-slate-600">
                    {pageIdx + 1} / {pages.length} ページ
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPageIdx((value) => Math.min(pages.length - 1, value + 1))}
                    disabled={pageIdx >= pages.length - 1}
                    aria-label="次のページ"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <span />
              )}
              {currentDoc && !docIsPdf ? (
                <div className="flex gap-2">
                  <Button variant="outline" size="icon" onClick={() => setZoom((value) => Math.max(0.75, value - 0.1))} aria-label="縮小">
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))} aria-label="拡大">
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="relative h-[560px] overflow-auto rounded-lg border bg-slate-100 p-4">
              {currentDoc ? (
                docIsPdf ? (
                  <iframe src={currentDoc} title="採点用紙PDF" className="h-[528px] w-full rounded-lg bg-white shadow-sm" />
                ) : (
                  <div className="mx-auto w-full max-w-3xl origin-top transition-transform" style={{ transform: `scale(${zoom})` }}>
                    <img src={currentDoc} alt="採点用紙" className="w-full rounded-lg bg-white shadow-sm" />
                  </div>
                )
              ) : (
                <div className="flex aspect-[3/4] w-full items-center justify-center rounded-lg border border-dashed bg-white text-sm text-slate-500">
                  採点用紙画像はまだありません
                </div>
              )}
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

const STATE_CHIP: Record<CellReviewState, { label: string; variant: "warning" | "neutral" | "info" }> = {
  pending: { label: "未確認", variant: "warning" },
  kept: { label: "OCRのまま", variant: "neutral" },
  edited: { label: "修正済み", variant: "info" },
};

function CellReviewCard({
  cell,
  state,
  value,
  cropUrl,
  quickValues,
  active,
  onActivate,
  onKeep,
  onPick,
  onEdit,
  onOpenReference,
}: {
  cell: ScoreCell;
  state: CellReviewState;
  value: number | null;
  cropUrl?: string;
  quickValues: number[];
  active: boolean;
  onActivate: () => void;
  onKeep: () => void;
  onPick: (value: number) => void;
  onEdit: (value: number | null) => void;
  onOpenReference: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chip = STATE_CHIP[state];

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={ref}
      onMouseDown={onActivate}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-white p-3 transition-colors",
        active ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{cell.label ?? cell.key}</span>
        <div className="flex items-center gap-1.5">
          {cell.confidence < 1 ? <ConfidenceBadge confidence={cell.confidence} /> : null}
          <Badge variant={chip.variant}>{chip.label}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-[96px_1fr] gap-3">
        <div className="flex h-24 items-center justify-center overflow-hidden rounded-md border bg-slate-50">
          {cropUrl ? (
            <img src={cropUrl} alt={`${cell.key} の手書き`} className="max-h-full max-w-full object-contain" />
          ) : (
            <button
              type="button"
              onClick={onOpenReference}
              className="flex flex-col items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
            >
              <ImageOff className="h-5 w-5" />
              用紙で確認
            </button>
          )}
        </div>

        <div className="min-w-0">
          <div className="text-xs text-slate-500">OCR推測</div>
          <div className="text-2xl font-semibold tabular-nums">{cell.detectedValue ?? "—"}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {quickValues.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => onPick(candidate)}
                className={cn(
                  "h-8 w-8 rounded-md border text-sm font-semibold tabular-nums transition-colors",
                  value === candidate
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                )}
                aria-label={`値を ${candidate} にする`}
              >
                {candidate}
              </button>
            ))}
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={value ?? ""}
              onChange={(event) => onEdit(event.target.value === "" ? null : Number(event.target.value))}
              className="h-8 w-16 text-right font-semibold"
              aria-label={`${cell.key} の値`}
            />
          </div>
        </div>
      </div>

      <Button variant={state === "pending" ? "default" : "outline"} size="sm" onClick={onKeep} className="self-end">
        <Check className="h-4 w-4" />
        この値でOK
      </Button>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const tone = confidenceTone(confidence);
  const variant = tone === "emerald" ? "success" : tone === "amber" ? "warning" : "destructive";
  return <Badge variant={variant}>{Math.round(confidence * 100)}%</Badge>;
}

function isPdfDocument(mimeType?: string, url?: string) {
  if (mimeType?.toLowerCase() === "application/pdf") return true;
  if (/^https:\/\/drive\.google\.com\/file\/d\//i.test(url ?? "")) return true;
  return Boolean(url && /\.pdf(?:[?#]|$)/i.test(url));
}
