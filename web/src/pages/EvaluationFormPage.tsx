import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { EVAL_ITEMS, EVAL_MAX_TOTAL, EVAL_SCORE_OPTIONS } from "@/lib/evaluation";
import type {
  EvaluationItemKey,
  EvaluationItemMaster,
  GetEvaluationResponse,
  GetResultResponse,
  ListEvaluationMetaResponse,
} from "@/lib/types";
import { formatDate } from "@/lib/utils";

type ItemState = { score: string; comment: string };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyItems(): Record<EvaluationItemKey, ItemState> {
  return EVAL_ITEMS.reduce(
    (acc, item) => ({ ...acc, [item.key]: { score: "", comment: "" } }),
    {} as Record<EvaluationItemKey, ItemState>,
  );
}

export default function EvaluationFormPage() {
  const { id = "", evaluationId = "" } = useParams();
  const isEdit = Boolean(evaluationId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [evaluatorName, setEvaluatorName] = useState("");
  const [evalDate, setEvalDate] = useState(todayIso());
  const [overallComment, setOverallComment] = useState("");
  const [items, setItems] = useState<Record<EvaluationItemKey, ItemState>>(emptyItems);
  const [initialized, setInitialized] = useState(false);

  const metaQuery = useQuery({
    queryKey: ["evaluationMeta"],
    queryFn: () => postApi<Record<string, never>, ListEvaluationMetaResponse>("listEvaluationMeta", {}),
  });

  const candidateQuery = useQuery({
    queryKey: ["result", id],
    queryFn: () => postApi<{ candidateId: string }, GetResultResponse>("getResult", { candidateId: id }),
    enabled: Boolean(id),
  });

  const evaluationQuery = useQuery({
    queryKey: ["evaluation", evaluationId],
    queryFn: () => postApi<{ evaluationId: string }, GetEvaluationResponse>("getEvaluation", { evaluationId }),
    enabled: isEdit,
  });

  const masterItems: EvaluationItemMaster[] = metaQuery.data?.items?.length ? metaQuery.data.items : EVAL_ITEMS;
  const evaluatorOptions = metaQuery.data?.evaluators ?? [];

  // 編集時のみ既存評定でプリフィル。一度だけ。
  useEffect(() => {
    if (initialized || !isEdit) return;
    const evaluation = evaluationQuery.data?.evaluation;
    if (!evaluation) return;
    setEvaluatorName(evaluation.evaluatorName);
    setEvalDate(evaluation.evalDate || todayIso());
    setOverallComment(evaluation.overallComment);
    setItems(() => {
      const next = emptyItems();
      for (const item of evaluation.items) {
        next[item.key] = { score: String(item.score), comment: item.comment };
      }
      return next;
    });
    setInitialized(true);
  }, [initialized, isEdit, evaluationQuery.data]);

  const totalScore = useMemo(
    () => EVAL_ITEMS.reduce((sum, item) => sum + (Number(items[item.key]?.score) || 0), 0),
    [items],
  );
  const allScored = EVAL_ITEMS.every((item) => items[item.key]?.score);

  const registerMutation = useMutation({
    mutationFn: (name: string) =>
      postApi<{ name: string; operationId: string }, { evaluator: { evaluatorId: string; name: string } }>("registerEvaluator", {
        name,
        operationId: newOperationId(),
      }),
    onSuccess: (data) => {
      toast.success(`評価者「${data.evaluator.name}」を登録しました`);
      queryClient.invalidateQueries({ queryKey: ["evaluationMeta"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "評価者を登録できませんでした"),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      postApi<Record<string, unknown>, { evaluation: { evaluationId: string } }>("saveEvaluation", {
        candidateId: id,
        evaluationId: isEdit ? evaluationId : undefined,
        evaluatorName: evaluatorName.trim(),
        evalDate,
        overallComment,
        items: EVAL_ITEMS.map((item) => ({
          key: item.key,
          score: Number(items[item.key].score),
          comment: items[item.key].comment,
        })),
        operationId: newOperationId(),
      }),
    onSuccess: () => {
      toast.success(isEdit ? "評定を更新しました" : "評定を登録しました");
      queryClient.invalidateQueries({ queryKey: ["evaluations", id] });
      navigate(`/candidates/${id}/result`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "評定を保存できませんでした"),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!evaluatorName.trim()) {
      toast.error("評価者名を入力してください");
      return;
    }
    if (!allScored) {
      toast.error("6項目すべての評価を選択してください");
      return;
    }
    saveMutation.mutate();
  };

  const setItemScore = (key: EvaluationItemKey, score: string) =>
    setItems((prev) => ({ ...prev, [key]: { ...prev[key], score } }));
  const setItemComment = (key: EvaluationItemKey, comment: string) =>
    setItems((prev) => ({ ...prev, [key]: { ...prev[key], comment } }));

  const isLoading = metaQuery.isLoading || candidateQuery.isLoading || (isEdit && evaluationQuery.isLoading);
  const candidateName = candidateQuery.data?.candidate.name ?? "";
  const alreadyRegistered = evaluatorOptions.some((option) => option.name === evaluatorName.trim());
  const canRegister = Boolean(evaluatorName.trim()) && !alreadyRegistered;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-[520px]" />
      </div>
    );
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      <Card>
        <CardContent className="flex flex-col gap-2 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-semibold">総合評定{isEdit ? "を編集" : "を追加"}</h1>
            <Button asChild variant="ghost" size="sm">
              <Link to={`/candidates/${id}/result`}>受験者ページへ戻る</Link>
            </Button>
          </div>
          <p className="text-sm text-slate-600">
            受験者: <span className="font-medium text-slate-900">{candidateName || id}</span>
            {candidateQuery.data?.candidate.testDate ? `（受験日 ${formatDate(candidateQuery.data.candidate.testDate)}）` : ""}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>評定ヘッダー</CardTitle>
          <CardDescription>評価者・評価日を入力します</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="evaluatorName">評価者氏名（面接官）</Label>
            <div className="flex gap-2">
              <Input
                id="evaluatorName"
                list="evaluator-options"
                value={evaluatorName}
                onChange={(event) => setEvaluatorName(event.target.value)}
                placeholder="選択 または 入力"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => registerMutation.mutate(evaluatorName.trim())}
                disabled={!canRegister || registerMutation.isPending}
                title={alreadyRegistered ? "登録済みです" : "候補リストに登録します"}
              >
                {registerMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                登録する
              </Button>
            </div>
            <datalist id="evaluator-options">
              {evaluatorOptions.map((option) => (
                <option key={option.evaluatorId} value={option.name} />
              ))}
            </datalist>
            <p className="text-xs text-slate-500">
              {alreadyRegistered ? "登録済みの評価者です" : "「登録する」で次回から候補に出ます（任意）"}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="evalDate">評価日（面接日）</Label>
            <Input id="evalDate" type="date" value={evalDate} onChange={(event) => setEvalDate(event.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>評価要素（6項目）</CardTitle>
          <CardDescription>各要素を 5〜1 で評価し、必要に応じて所見を記入します（5:秀 / 4:優 / 3:良 / 2:可 / 1:不可）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {masterItems.map((master) => (
            <div key={master.key} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_160px]">
              <div className="space-y-1">
                <div className="font-medium">{master.label}</div>
                <p className="text-xs leading-5 text-slate-500">{master.description}</p>
                <Textarea
                  className="mt-2"
                  value={items[master.key]?.comment ?? ""}
                  onChange={(event) => setItemComment(master.key, event.target.value)}
                  placeholder="所見（任意）"
                />
              </div>
              <div className="space-y-2">
                <Label>評価</Label>
                <Select value={items[master.key]?.score ?? ""} onValueChange={(value) => setItemScore(master.key, value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {EVAL_SCORE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={String(option.value)}>
                        {option.label}（{option.note}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>総合所見</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={overallComment}
            onChange={(event) => setOverallComment(event.target.value)}
            placeholder="全体を通しての所見（任意）"
            className="min-h-32"
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-600">
              合計点: <span className="text-2xl font-semibold text-slate-900">{totalScore}</span>
              <span className="text-slate-500"> ／ {EVAL_MAX_TOTAL}点</span>
              {!allScored ? <span className="ml-2 text-amber-600">（未選択の項目があります）</span> : null}
            </div>
            <div className="flex gap-2">
              <Button asChild type="button" variant="outline">
                <Link to={`/candidates/${id}/result`}>キャンセル</Link>
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isEdit ? "更新する" : "登録する"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
