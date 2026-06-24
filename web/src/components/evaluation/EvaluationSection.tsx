import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { EVAL_MAX_TOTAL, itemLabel, summarize } from "@/lib/evaluation";
import type { Evaluation, ListEvaluationsResponse } from "@/lib/types";
import { formatDate } from "@/lib/utils";

export function EvaluationSection({ candidateId }: { candidateId: string }) {
  const { can } = useAuth();
  const canDelete = can("reviewer");
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<Evaluation | null>(null);

  const query = useQuery({
    queryKey: ["evaluations", candidateId],
    queryFn: () => postApi<{ candidateId: string }, ListEvaluationsResponse>("listEvaluations", { candidateId }),
    enabled: Boolean(candidateId),
  });

  const evaluations = query.data?.evaluations ?? [];
  const summary = useMemo(() => summarize(evaluations), [evaluations]);

  const deleteMutation = useMutation({
    mutationFn: (evaluation: Evaluation) =>
      postApi<{ candidateId: string; evaluationId: string; operationId: string }, { deleted: boolean }>("deleteEvaluation", {
        candidateId,
        evaluationId: evaluation.evaluationId,
        operationId: newOperationId(),
      }),
    onSuccess: () => {
      toast.success("評定を削除しました");
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["evaluations", candidateId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "評定を削除できませんでした"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>総合評定（面接評価）</CardTitle>
          <CardDescription>面接官による 6 項目評価。複数名で評価できます。</CardDescription>
        </div>
        <Button asChild size="sm">
          <Link to={`/candidates/${candidateId}/evaluation/new`}>
            <Plus className="h-4 w-4" />
            評定を追加
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {query.isLoading ? (
          <p className="text-sm text-slate-600">読み込み中…</p>
        ) : evaluations.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-slate-600">まだ評定がありません。</p>
            <Button asChild variant="outline" className="mt-4">
              <Link to={`/candidates/${candidateId}/evaluation/new`}>最初の評定を追加</Link>
            </Button>
          </div>
        ) : (
          <>
            <SummaryCard summary={summary} />
            <div className="space-y-4">
              {evaluations.map((evaluation) => (
                <EvaluationCard
                  key={evaluation.evaluationId}
                  candidateId={candidateId}
                  evaluation={evaluation}
                  canDelete={canDelete}
                  onDelete={() => setPendingDelete(evaluation)}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>評定を削除しますか？</DialogTitle>
            <DialogDescription>
              {pendingDelete ? `評価者「${pendingDelete.evaluatorName}」の評定を削除します。この操作は取り消せません。` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleteMutation.isPending}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              削除する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SummaryCard({ summary }: { summary: ReturnType<typeof summarize> }) {
  return (
    <div className="rounded-lg border bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div className="text-sm text-slate-600">
          評定件数 <span className="text-xl font-semibold text-slate-900">{summary.count}</span> 件
        </div>
        <div className="text-sm text-slate-600">
          合計点の平均{" "}
          <span className="text-2xl font-semibold text-indigo-600">
            {summary.averageTotal ?? "-"}
          </span>
          <span className="text-slate-500"> ／ {EVAL_MAX_TOTAL}点</span>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {summary.itemAverages.map((item) => (
          <div key={item.key} className="flex items-center justify-between rounded border bg-white px-3 py-2 text-sm">
            <span className="text-slate-700">{item.label}</span>
            <span className="font-semibold text-slate-900">{item.average ?? "-"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EvaluationCard({
  candidateId,
  evaluation,
  canDelete,
  onDelete,
}: {
  candidateId: string;
  evaluation: Evaluation;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium text-slate-900">{evaluation.evaluatorName || "（評価者未設定）"}</div>
          <div className="text-xs text-slate-500">
            {evaluation.evalDate ? `評価日 ${formatDate(evaluation.evalDate)}` : "評価日未設定"}
            {evaluation.jobRole ? ` / ${evaluation.jobRole}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-sm text-slate-600">
            合計 <span className="text-lg font-semibold text-slate-900">{evaluation.totalScore}</span>
            <span className="text-slate-500"> ／ {EVAL_MAX_TOTAL}</span>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/candidates/${candidateId}/evaluation/${evaluation.evaluationId}/edit`}>
              <Pencil className="h-4 w-4" />
              編集
            </Link>
          </Button>
          {canDelete ? (
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 divide-y rounded-md border">
        {evaluation.items.map((item) => (
          <div key={item.key} className="grid gap-2 p-3 md:grid-cols-[minmax(140px,0.4fr)_56px_1fr] md:items-center">
            <div className="text-sm font-medium text-slate-800">{itemLabel(item.key)}</div>
            <div className="text-sm font-semibold text-indigo-600">{item.score}</div>
            <p className="text-sm leading-6 text-slate-600">{item.comment || "—"}</p>
          </div>
        ))}
      </div>

      {evaluation.overallComment ? (
        <div className="mt-3 rounded-md bg-slate-50 p-3">
          <div className="text-xs font-medium text-slate-500">総合所見</div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">{evaluation.overallComment}</p>
        </div>
      ) : null}
    </div>
  );
}
