import { KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, Save, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { normalizeGetCellsResponse } from "@/lib/api-normalizers";
import { useAuth } from "@/lib/auth";
import { confidenceTone } from "@/lib/labels";
import { isApiError, postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { CellKey, SaveCellsPayload, ScoreCell } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ReviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [activeKey, setActiveKey] = useState<CellKey | null>(null);
  const [edited, setEdited] = useState<Record<CellKey, number | null>>({});
  const [confirmed, setConfirmed] = useState<Set<CellKey>>(new Set());
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
    const values = Object.fromEntries(
      query.data.cells.map((cell) => [cell.key, cell.value ?? cell.detectedValue ?? null]),
    ) as Record<CellKey, number | null>;
    setEdited(values);
    setConfirmed(new Set(query.data.cells.filter((cell) => cell.resolved).map((cell) => cell.key)));
    setActiveKey(query.data.reviewQueue[0] ?? query.data.cells[0]?.key ?? null);
  }, [query.data]);

  const cells = query.data?.cells ?? [];
  const queue = query.data?.reviewQueue ?? [];
  const activeCell = cells.find((cell) => cell.key === activeKey) ?? null;
  const resolvedCount = queue.filter((key) => confirmed.has(key)).length;
  const progress = queue.length ? Math.round((resolvedCount / queue.length) * 100) : 100;
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

  const orderedKeys = useMemo(() => (queue.length ? queue : cells.map((cell) => cell.key)), [cells, queue]);

  const move = (direction: 1 | -1) => {
    if (!activeKey || orderedKeys.length === 0) return;
    const index = orderedKeys.indexOf(activeKey);
    const next = Math.min(Math.max(index + direction, 0), orderedKeys.length - 1);
    setActiveKey(orderedKeys[next]);
  };

  const confirmAndNext = () => {
    if (!activeKey) return;
    setConfirmed((current) => new Set(current).add(activeKey));
    move(1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      confirmAndNext();
      return;
    }
    if (/^[0-9]$/.test(event.key) && activeKey && event.target instanceof HTMLElement && event.target.tagName !== "INPUT") {
      setEdited((current) => ({ ...current, [activeKey]: Number(event.key) }));
      setConfirmed((current) => new Set(current).add(activeKey));
    }
  };

  const save = () => {
    saveMutation.mutate({
      candidateId: id,
      cells: buildPayloadCells(),
      operationId: newOperationId(),
    });
  };

  if (query.isLoading) {
    return (
      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
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

  const imageLinks = query.data?.imageLinks ?? {};
  const documentUrl = imageLinks.preview ?? imageLinks.original;
  const isPdf = isPdfDocument(imageLinks.mimeType, documentUrl);

  return (
    <div className="space-y-5" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">採点レビュー</h1>
          <p className="mt-1 text-sm text-slate-600">要確認セルを確認し、必要に応じて検出値を修正します。</p>
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
            onClick={() => finalizeMutation.mutate()}
            disabled={!can("reviewer") || finalizeMutation.isPending}
            title={!can("reviewer") ? "reviewer以上のみ確定できます" : undefined}
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
        <CardContent className="p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-medium">
              解決 {resolvedCount} / 全 {queue.length}
            </div>
            <div className="text-sm text-slate-600">↑↓で移動、Enterで確定、数字キーで入力</div>
          </div>
          <Progress value={progress} className="mt-3" />
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>採点用紙ビューア</CardTitle>
              <CardDescription>
                現在セル: {activeCell?.label ?? activeCell?.key ?? "-"}
              </CardDescription>
            </div>
            {!isPdf ? (
              <div className="flex gap-2">
                <Button variant="outline" size="icon" onClick={() => setZoom((current) => Math.max(0.75, current - 0.1))} aria-label="縮小">
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={() => setZoom((current) => Math.min(1.8, current + 0.1))} aria-label="拡大">
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            <div className="relative h-[620px] overflow-auto rounded-lg border bg-slate-100 p-4">
              {documentUrl ? (
                isPdf ? (
                  <iframe
                    src={documentUrl}
                    title="採点用紙PDF"
                    className="h-[588px] w-full rounded-lg bg-white shadow-sm"
                  />
                ) : (
                  <div className="relative mx-auto w-full max-w-3xl origin-top transition-transform" style={{ transform: `scale(${zoom})` }}>
                    <img
                      src={documentUrl}
                      alt="採点用紙"
                      className="w-full rounded-lg bg-white shadow-sm"
                    />
                    {activeCell?.bbox ? <CellHighlight cell={activeCell} /> : null}
                  </div>
                )
              ) : (
                <div className="flex aspect-[3/4] w-full items-center justify-center rounded-lg border border-dashed bg-white text-sm text-slate-500">
                  採点用紙画像はまだありません
                </div>
              )}
              </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>セル確認</CardTitle>
            <CardDescription>低信頼セルを優先して修正します。</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="queue">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="queue">要確認</TabsTrigger>
                <TabsTrigger value="heatmap">80セル</TabsTrigger>
              </TabsList>
              <TabsContent value="queue" className="max-h-[620px] overflow-auto pr-1 scrollbar-stable">
                <div className="space-y-2">
                  {(queue.length ? queue : cells.map((cell) => cell.key)).map((key) => {
                    const cell = cells.find((target) => target.key === key);
                    if (!cell) return null;
                    return (
                      <CellEditorRow
                        key={cell.key}
                        cell={cell}
                        active={cell.key === activeKey}
                        confirmed={confirmed.has(cell.key)}
                        value={edited[cell.key] ?? null}
                        onFocus={() => setActiveKey(cell.key)}
                        onChange={(value) => {
                          setEdited((current) => ({ ...current, [cell.key]: value }));
                          setConfirmed((current) => new Set(current).add(cell.key));
                        }}
                      />
                    );
                  })}
                </div>
              </TabsContent>
              <TabsContent value="heatmap">
                <div className="grid grid-cols-8 gap-2">
                  {cells.map((cell) => (
                    <button
                      type="button"
                      key={cell.key}
                      onClick={() => setActiveKey(cell.key)}
                      className={cn(
                        "aspect-square rounded-lg border text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        heatmapClass(cell.confidence),
                        cell.key === activeKey && "ring-2 ring-indigo-600 ring-offset-2",
                      )}
                      aria-label={`${cell.key} 信頼度 ${Math.round(cell.confidence * 100)}%`}
                    >
                      {cell.key.replace("s", "")}
                    </button>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CellEditorRow({
  cell,
  active,
  confirmed,
  value,
  onFocus,
  onChange,
}: {
  cell: ScoreCell;
  active: boolean;
  confirmed: boolean;
  value: number | null;
  onFocus: () => void;
  onChange: (value: number | null) => void;
}) {
  const tone = confidenceTone(cell.confidence);
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_112px] gap-3 rounded-lg border p-3 transition-colors",
        active && "border-indigo-500 bg-indigo-50",
      )}
    >
      <button type="button" className="min-w-0 text-left" onClick={onFocus}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{cell.label ?? cell.key}</span>
          <ConfidenceBadge confidence={cell.confidence} />
          {confirmed ? <Badge variant="success">解決済み</Badge> : null}
        </div>
        <div className="mt-1 text-sm text-slate-600">
          検出値: {cell.detectedValue ?? "-"} / 行 {cell.row} 列 {cell.col}
        </div>
      </button>
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        value={value ?? ""}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        className={cn(
          "text-right font-semibold",
          tone === "red" && "border-red-300",
          tone === "amber" && "border-amber-300",
          tone === "emerald" && "border-emerald-300",
        )}
        aria-label={`${cell.key} の値`}
      />
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const tone = confidenceTone(confidence);
  const variant = tone === "emerald" ? "success" : tone === "amber" ? "warning" : "destructive";
  return <Badge variant={variant}>{Math.round(confidence * 100)}%</Badge>;
}

function heatmapClass(confidence: number) {
  const tone = confidenceTone(confidence);
  if (tone === "emerald") return "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100";
  if (tone === "amber") return "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100";
  return "border-red-200 bg-red-50 text-red-800 hover:bg-red-100";
}

function isPdfDocument(mimeType?: string, url?: string) {
  if (mimeType?.toLowerCase() === "application/pdf") return true;
  if (/^https:\/\/drive\.google\.com\/file\/d\//i.test(url ?? "")) return true;
  return Boolean(url && /\.pdf(?:[?#]|$)/i.test(url));
}

function CellHighlight({ cell }: { cell: ScoreCell }) {
  if (!cell.bbox) return null;
  const left = dimension(cell.bbox.x);
  const top = dimension(cell.bbox.y);
  const width = dimension(cell.bbox.width);
  const height = dimension(cell.bbox.height);
  return (
    <div
      className="pointer-events-none absolute rounded-md border-2 border-indigo-600 bg-indigo-500/20 shadow-[0_0_0_9999px_rgba(15,23,42,0.18)]"
      style={{ left, top, width, height }}
    />
  );
}

function dimension(value: number) {
  return `${value <= 1 ? value * 100 : value}%`;
}
