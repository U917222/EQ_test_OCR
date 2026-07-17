import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FileText, FileUp, Loader2, Pencil, Save } from "lucide-react";
import {
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EvaluationSection } from "@/components/evaluation/EvaluationSection";
import { CandidateDocumentsCard } from "@/components/candidates/CandidateDocumentsCard";
import { useAuth } from "@/lib/auth";
import { normalizeGetResultResponse } from "@/lib/api-normalizers";
import { buildProfileChartData, CHEQ_ITEMS, traitCopyForStage } from "@/lib/cheq";
import { decisionLabels, decisionVariant, rankVariant, stageTone, statusLabels, statusVariant } from "@/lib/labels";
import { isApiError, postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { AttachScoresheetPayload, Candidate, CheqItem, Decision, GetResultResponse } from "@/lib/types";
import { prepareUploadFile } from "@/lib/upload";
import { formatDate } from "@/lib/utils";

type ResultPdfResponse = {
  filename: string;
  mimeType: "application/pdf";
  base64: string;
};

export default function ResultPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canOperate = can("operator");
  const canReview = can("reviewer");
  const [decision, setDecision] = useState<Decision | "">("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const autoFinalizeStarted = useRef(false);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["result", id],
    queryFn: async () =>
      normalizeGetResultResponse(await postApi<{ candidateId: string }, unknown>("getResult", { candidateId: id })),
    enabled: Boolean(id),
    refetchInterval: (queryState) => {
      const payload = queryState.state.data as GetResultResponse | undefined;
      const status = payload?.result?.status ?? payload?.candidate?.status;
      return status === "recognizing" ? 3000 : false;
    },
  });

  useEffect(() => {
    if (query.error) toast.error("結果を取得できませんでした");
  }, [query.error]);

  useEffect(() => {
    if (!query.data?.candidate) return;
    setDecision(normalizeDecision(query.data.candidate.decision));
    setEmployeeNumber(query.data.candidate.employeeNumber ?? "");
  }, [query.data]);

  const decisionMutation = useMutation({
    mutationFn: (payload: { decision: Decision; employeeNumber?: string }) =>
      postApi<
        { candidateId: string; decision: Decision; employeeNumber?: string; operationId: string },
        { candidate: Candidate }
      >("saveDecision", {
        candidateId: id,
        decision: payload.decision,
        employeeNumber: payload.employeeNumber,
        operationId: newOperationId(),
      }),
    onSuccess: (data) => {
      toast.success("合否を登録しました");
      queryClient.setQueryData<GetResultResponse>(["result", id], (current) =>
        current ? { ...current, candidate: data.candidate } : current,
      );
      queryClient.invalidateQueries({ queryKey: ["result", id] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
    },
    onError: () => toast.error("合否を登録できませんでした"),
  });

  const pdfMutation = useMutation({
    mutationFn: () => postApi<{ candidateId: string }, ResultPdfResponse>("getResultPdf", { candidateId: id }),
    onSuccess: (pdf) => {
      const byteCharacters = atob(pdf.base64);
      const byteNumbers = Array.from(byteCharacters, (character) => character.charCodeAt(0));
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: pdf.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = pdf.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    onError: () => toast.error("PDFを取得できませんでした"),
  });

  const finalizeMutation = useMutation({
    mutationFn: () =>
      postApi<{ candidateId: string; operationId: string }, { result: unknown }>("finalize", {
        candidateId: id,
        operationId: newOperationId(),
      }),
    onSuccess: () => {
      toast.success("採点を確定しました");
      queryClient.invalidateQueries({ queryKey: ["result", id] });
    },
    onError: () => toast.error("採点を確定できませんでした"),
  });

  const attachScoresheetMutation = useMutation({
    mutationFn: async (file: File) => {
      const uploadFile = await prepareUploadFile(file);
      const payload: AttachScoresheetPayload = {
        candidateId: id,
        file: uploadFile,
        operationId: newOperationId(),
      };
      return postApi<AttachScoresheetPayload, { candidate: Candidate; result?: unknown }>("attachScoresheet", payload);
    },
    onSuccess: () => {
      toast.success("採点用紙をアップロードしました");
      queryClient.invalidateQueries({ queryKey: ["result", id] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : "採点用紙をアップロードできませんでした"),
  });

  useEffect(() => {
    const status = query.data?.result?.status ?? query.data?.candidate?.status;
    const hasSourceUrl = Boolean(query.data?.candidate?.sourceUrl || query.data?.sourceUrl);
    if (
      !canReview ||
      query.data?.result ||
      !hasSourceUrl ||
      status !== "scored" ||
      autoFinalizeStarted.current
    ) return;
    autoFinalizeStarted.current = true;
    finalizeMutation.mutate();
  }, [canReview, finalizeMutation, query.data]);

  const selectScoresheet = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      toast.error("画像またはPDFを選択してください");
      return;
    }
    attachScoresheetMutation.mutate(file);
  };

  const submitDecision = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canReview) return;
    if (!decision) {
      toast.error("合否を選択してください");
      return;
    }
    decisionMutation.mutate({
      decision,
      employeeNumber: decision === "hire" ? employeeNumber.trim() || undefined : undefined,
    });
  };

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-[420px]" />
      </div>
    );
  }

  const data = query.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
          <h1 className="text-lg font-semibold">結果を取得できませんでした</h1>
          <p className="mt-2 text-sm text-slate-600">時間をおいて再読み込みしてください。</p>
        </CardContent>
      </Card>
    );
  }

  const { candidate, rawCellSummary, result, sourceUrl } = data;
  const scoresheetUrl = candidate.sourceUrl || sourceUrl;
  const status = result?.status ?? candidate.status;
  const currentDecision = normalizeDecision(candidate.decision);
  const isTestNotStarted = result === null && !scoresheetUrl;
  const isRecognizing = !isTestNotStarted && (status === "uploaded" || status === "recognizing");

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-col gap-5 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-normal">{candidate.name}</h1>
              <Badge variant={statusVariant(status)}>{statusLabels[status]}</Badge>
              <Badge variant={currentDecision ? decisionVariant(currentDecision) : "outline"}>
                {currentDecision ? decisionLabels[currentDecision] : "未登録"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">受験日: {formatDate(candidate.testDate)}</p>
            <CandidateProfileSummary candidate={candidate} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to={`/candidates/${id}/edit`}>
                <Pencil className="h-4 w-4" />
                候補者情報
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/candidates/${id}/review`}>
                <FileText className="h-4 w-4" />
                採点を見直す
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => pdfMutation.mutate()}
              disabled={!canReview || pdfMutation.isPending}
              title={!canReview ? "reviewer以上のみダウンロードできます" : undefined}
            >
              {pdfMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              結果PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      <CandidateDocumentsCard candidateId={id} />

      {result === null ? (
        <Card>
          <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
            <h2 className="text-lg font-semibold">
              {isTestNotStarted
                ? "テスト未実施"
                : isRecognizing
                  ? "OCRで読み取り中です"
                  : "まだ採点が確定していません"}
            </h2>
            <p className="mt-2 max-w-xl text-sm text-slate-600">
              {isTestNotStarted
                ? "採点用紙をアップロードしてOCRするか、採点画面でセルを手入力してください。"
                : isRecognizing
                ? "読み取りが完了すると自動で画面を更新します。確認が不要な場合はそのまま採点確定へ進みます。"
                : "セル確認と採点確定が完了すると、総合判定、プロフィール、確認事項、合否登録が表示されます。"}
            </p>
            <Input
              ref={attachInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              disabled={!canOperate || attachScoresheetMutation.isPending}
              onChange={(event) => {
                selectScoresheet(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            {isTestNotStarted ? (
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={!canOperate || attachScoresheetMutation.isPending}
                  title={!canOperate ? "operator以上のみアップロードできます" : undefined}
                >
                  {attachScoresheetMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileUp className="h-4 w-4" />
                  )}
                  採点用紙をアップロード
                </Button>
                <Button asChild>
                  <Link to={`/candidates/${id}/review`}>採点する</Link>
                </Button>
              </div>
            ) : status === "scored" && canReview ? (
              <Button className="mt-5" onClick={() => finalizeMutation.mutate()} disabled={finalizeMutation.isPending}>
                {finalizeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                採点を確定
              </Button>
            ) : (
              <Button asChild className="mt-5">
                <Link to={`/candidates/${id}/review`}>採点する</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="総合判定"
              value={result.totalRank || "-"}
              badge={result.totalRank ? rankVariant(result.totalRank) : "outline"}
              emphasis
            />
            <MetricCard
              label="マイナスポイント"
              value={result.jobRequirementMinusPoints}
              detail={formatLowItems(result.jobRequirementLowItems)}
              emphasis
            />
            <MetricCard
              label="応答態度"
              value={result.responseAttitudeStage ? `段階 ${result.responseAttitudeStage}` : "-"}
              detail={result.attitudeMinusPoints ? `減点 ${result.attitudeMinusPoints}` : undefined}
            />
            <MetricCard label="要確認" value={`${rawCellSummary?.unresolvedCount ?? 0} 件`} />
          </div>

          <ProfileCard result={result} />
          <AttentionCard result={result} sourceUrl={scoresheetUrl} />
          <DecisionCard
            candidate={candidate}
            canReview={canReview}
            decision={decision}
            employeeNumber={employeeNumber}
            isPending={decisionMutation.isPending}
            onDecisionChange={(next) => {
              setDecision(next);
              if (next === "reject") setEmployeeNumber("");
            }}
            onEmployeeNumberChange={setEmployeeNumber}
            onSubmit={submitDecision}
          />
        </>
      )}

      <EvaluationSection candidateId={id} />
    </div>
  );
}

function CandidateProfileSummary({ candidate }: { candidate: Candidate }) {
  const address = formatAddress(candidate);
  const rows = [
    genderLabel(candidate.gender) ? `性別: ${genderLabel(candidate.gender)}` : "",
    address ? `住所: ${address}` : "",
    candidate.memo ? `メモ: ${candidate.memo}` : "",
  ].filter(Boolean);
  if (!rows.length) return null;
  return <p className="mt-2 max-w-3xl text-sm text-slate-600">{rows.join(" / ")}</p>;
}

function genderLabel(value: Candidate["gender"]) {
  if (value === "male") return "男性";
  if (value === "female") return "女性";
  if (value === "other") return "その他";
  return "";
}

function formatAddress(candidate: Candidate) {
  return [candidate.postalCode ? `〒${candidate.postalCode}` : "", candidate.prefecture, candidate.city, candidate.addressLine]
    .filter(Boolean)
    .join(" ");
}

function MetricCard({
  label,
  value,
  detail,
  badge,
  emphasis,
}: {
  label: string;
  value: string | number;
  detail?: string;
  badge?: BadgeProps["variant"];
  emphasis?: boolean;
}) {
  const valueClassName = `${emphasis ? "text-4xl" : "text-3xl"} font-semibold tracking-normal ${valueToneClass(
    badge,
  )}`.trim();

  return (
    <Card className={emphasis ? "border-2 border-indigo-500 bg-indigo-50/60 shadow-md" : undefined}>
      <CardContent className="p-5">
        <div className={emphasis ? "text-sm font-medium text-slate-700" : "text-sm text-slate-500"}>{label}</div>
        <div className="mt-3 flex items-center gap-2">
          <div className={valueClassName}>{value}</div>
        </div>
        {detail ? <p className="mt-2 line-clamp-2 text-sm text-slate-600">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function valueToneClass(variant: BadgeProps["variant"]) {
  if (variant === "success") return "text-emerald-600";
  if (variant === "info") return "text-sky-600";
  if (variant === "warning") return "text-amber-600";
  if (variant === "destructive") return "text-red-600";
  return "";
}

function ProfileCard({ result }: { result: NonNullable<GetResultResponse["result"]> }) {
  const chartData = buildProfileChartData(result);
  const orderedItems = useMemo(() => orderCheqItems(result.items), [result.items]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>カテゴリ別プロフィール</CardTitle>
        <CardDescription>現状段階と応答態度マイナス適用後の比較</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 24, right: 24, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="category" />
              <YAxis domain={[1, 5]} allowDecimals={false} ticks={[1, 2, 3, 4, 5]} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="current" name="現状" stroke="#4f46e5" strokeWidth={2} dot>
                <LabelList dataKey="current" position="top" />
              </Line>
              <Line
                type="monotone"
                dataKey="afterMinus"
                name="応答態度マイナス適用後"
                stroke="#dc2626"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="divide-y rounded-lg border">
          {orderedItems.map((item) => (
            <div key={item.key} className="grid gap-3 p-4 md:grid-cols-[minmax(140px,0.35fr)_96px_96px_1fr] md:items-center">
              <div className="font-medium">{item.label}</div>
              <div className="text-sm text-slate-600">{item.total}点</div>
              <Badge variant={stageVariant(item.stage)}>段階 {item.stage}</Badge>
              <p className="text-sm leading-6 text-slate-700">{traitCopyForStage(item.label, item.stage)}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AttentionCard({
  result,
  sourceUrl,
}: {
  result: NonNullable<GetResultResponse["result"]>;
  sourceUrl?: string;
}) {
  const crossCheckIssues = result.crossCheck.filter(
    (item) => item.handwritten !== null && item.handwritten !== item.computed,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>注意領域・確認事項</CardTitle>
        <CardDescription>手書き突合、職務必要要件、元ファイル</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            手書き不一致
          </div>
          {crossCheckIssues.length ? (
            <div className="flex flex-wrap gap-2">
              {crossCheckIssues.map((item) => (
                <Badge key={item.item} variant="warning">
                  {item.item}: 手書き{item.handwritten ?? "-"} / 再計算{item.computed}
                </Badge>
              ))}
              <span className="text-sm text-slate-600">(システム再計算を正とする)</span>
            </div>
          ) : (
            <p className="text-sm text-slate-600">不一致なし</p>
          )}
        </section>

        <section className="space-y-2">
          <div className="text-sm font-medium">職務必要要件マイナス</div>
          {result.jobRequirementLowItems.length ? (
            <div className="flex flex-wrap gap-2">
              {result.jobRequirementLowItems.map((item) => (
                <Badge key={`${item.label}-${item.stage}`} variant={stageVariant(item.stage)}>
                  {item.label}(段階{item.stage})
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-600">該当なし</p>
          )}
        </section>

        {sourceUrl ? (
          <Button asChild variant="outline">
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              採点用紙を開く
            </a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DecisionCard({
  candidate,
  canReview,
  decision,
  employeeNumber,
  isPending,
  onDecisionChange,
  onEmployeeNumberChange,
  onSubmit,
}: {
  candidate: Candidate;
  canReview: boolean;
  decision: Decision | "";
  employeeNumber: string;
  isPending: boolean;
  onDecisionChange: (decision: Decision) => void;
  onEmployeeNumberChange: (employeeNumber: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const currentDecision = normalizeDecision(candidate.decision);

  return (
    <Card>
      <CardHeader>
        <CardTitle>採用合否登録</CardTitle>
        <CardDescription>現在: {currentDecisionText(candidate)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>合否</Label>
              <Select value={decision} onValueChange={(value) => onDecisionChange(value as Decision)} disabled={!canReview}>
                <SelectTrigger>
                  <SelectValue placeholder="選択してください" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hire">{decisionLabels.hire}</SelectItem>
                  <SelectItem value="reject">{decisionLabels.reject}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="employeeNumber">職員番号</Label>
              <Input
                id="employeeNumber"
                value={decision === "hire" ? employeeNumber : ""}
                onChange={(event) => onEmployeeNumberChange(event.target.value)}
                placeholder="合格時のみ入力"
                disabled={!canReview || decision !== "hire"}
              />
            </div>
          </div>

          {!canReview ? <p className="text-sm text-amber-700">reviewer以上のみ登録できます</p> : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1 text-sm text-slate-600">
              <div>
                現在:{" "}
                <Badge variant={currentDecision ? decisionVariant(currentDecision) : "outline"}>
                  {currentDecision ? decisionLabels[currentDecision] : "未登録"}
                </Badge>
              </div>
            </div>
            <Button type="submit" disabled={!canReview || isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              登録する
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function normalizeDecision(value?: string): Decision | "" {
  if (value === "hire" || value === "reject") return value;
  return "";
}

function currentDecisionText(candidate: Candidate) {
  const decision = normalizeDecision(candidate.decision);
  if (!decision) return "未登録";
  if (decision === "hire" && candidate.employeeNumber) {
    return `${decisionLabels[decision]}（職員番号 ${candidate.employeeNumber}）`;
  }
  return decisionLabels[decision];
}

function formatLowItems(items: Array<{ label: string; stage: number }>) {
  if (!items.length) return "なし";
  return items.map((item) => `${item.label}(段階${item.stage})`).join(", ");
}

function orderCheqItems(items: CheqItem[]) {
  const order = new Map(CHEQ_ITEMS.map((item, index) => [item.key, index]));
  return [...items].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

function stageVariant(stage: number): BadgeProps["variant"] {
  const tone = stageTone(stage);
  if (tone === "red") return "destructive";
  if (tone === "amber") return "warning";
  return "success";
}
