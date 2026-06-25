import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, LayoutGrid, List, Loader2, Pencil, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KanbanBoard } from "@/components/candidates/KanbanBoard";
import { useAuth } from "@/lib/auth";
import { decisionLabels, decisionVariant, statusLabels, statusVariant } from "@/lib/labels";
import { postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { Candidate, CandidateStatus } from "@/lib/types";
import { formatDate, formatDateTime } from "@/lib/utils";

type ViewMode = "kanban" | "table";

const statusOptions: Array<{ value: CandidateStatus | "all"; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "uploaded", label: statusLabels.uploaded },
  { value: "recognizing", label: statusLabels.recognizing },
  { value: "needs_review", label: statusLabels.needs_review },
  { value: "scored", label: statusLabels.scored },
  { value: "finalized", label: statusLabels.finalized },
];

export default function CandidatesPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [view, setView] = useState<ViewMode>("kanban");
  const [deleteTarget, setDeleteTarget] = useState<Candidate | null>(null);
  const status = (params.get("status") as CandidateStatus | null) ?? "all";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canMove = can("operator");
  const canEdit = can("operator");
  const canDelete = can("operator");

  // カンバンでは全ステータスを列として並べるため status フィルタは無視する。
  const queryPayload = useMemo(
    () => ({
      search: params.get("search") || undefined,
      status: view === "table" ? params.get("status") || undefined : undefined,
    }),
    [params, view],
  );

  const query = useQuery({
    queryKey: ["candidates", queryPayload],
    queryFn: () => postApi<typeof queryPayload, { candidates: Candidate[] }>("listCandidates", queryPayload),
  });

  useEffect(() => {
    if (query.error) toast.error("候補者一覧を取得できませんでした");
  }, [query.error]);

  const moveMutation = useMutation({
    mutationFn: (vars: { candidateId: string; status: CandidateStatus }) =>
      postApi<{ candidateId: string; status: CandidateStatus; operationId: string }, { candidate: Candidate }>(
        "updateStatus",
        { ...vars, operationId: newOperationId() },
      ),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["candidates"] });
      const key = ["candidates", queryPayload];
      const prev = queryClient.getQueryData<{ candidates: Candidate[] }>(key);
      if (prev) {
        queryClient.setQueryData(key, {
          candidates: prev.candidates.map((candidate) =>
            candidate.candidateId === vars.candidateId ? { ...candidate, status: vars.status } : candidate,
          ),
        });
      }
      return { prev, key };
    },
    onError: (_error, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(context.key, context.prev);
      toast.error("ステータスを更新できませんでした");
    },
    onSuccess: (_data, vars) => {
      toast.success(`「${statusLabels[vars.status]}」に移動しました`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["candidates"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (candidateId: string) =>
      postApi<{ candidateId: string; operationId: string }, { deleted: true; candidateId: string }>(
        "deleteCandidate",
        { candidateId, operationId: newOperationId() },
      ),
    onMutate: async (candidateId) => {
      await queryClient.cancelQueries({ queryKey: ["candidates"] });
      const previous = queryClient.getQueriesData<{ candidates: Candidate[] }>({ queryKey: ["candidates"] });
      queryClient.setQueriesData<{ candidates: Candidate[] }>({ queryKey: ["candidates"] }, (current) => {
        if (!current) return current;
        return {
          candidates: current.candidates.filter((candidate) => candidate.candidateId !== candidateId),
        };
      });
      return { previous };
    },
    onSuccess: (_data, candidateId) => {
      toast.success("候補者を削除しました");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      queryClient.removeQueries({ queryKey: ["result", candidateId] });
    },
    onError: (_error, _candidateId, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
      toast.error("候補者を削除できませんでした");
    },
  });

  const applySearch = () => {
    const next = new URLSearchParams(params);
    if (search) next.set("search", search);
    else next.delete("search");
    setParams(next);
  };

  const setStatus = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("status");
    else next.set("status", value);
    setParams(next);
  };

  const candidates = query.data?.candidates ?? [];

  const handleMove = (candidateId: string, toStatus: CandidateStatus) => {
    const target = candidates.find((candidate) => candidate.candidateId === candidateId);
    if (!target || target.status === toStatus) return;
    moveMutation.mutate({ candidateId, status: toStatus });
  };

  const editCandidate = (candidate: Candidate) => {
    if (!canEdit) return;
    navigate(`/candidates/${candidate.candidateId}/edit`);
  };

  const requestDelete = (candidate: Candidate) => {
    if (!canDelete) return;
    setDeleteTarget(candidate);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">候補者一覧</h1>
          <p className="mt-1 text-sm text-slate-600">採点用紙の登録状況と判定を確認します。</p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={view} onValueChange={(value) => setView(value as ViewMode)}>
            <TabsList>
              <TabsTrigger value="kanban">
                <LayoutGrid className="mr-1.5 h-4 w-4" />
                カンバン
              </TabsTrigger>
              <TabsTrigger value="table">
                <List className="mr-1.5 h-4 w-4" />
                テーブル
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button asChild>
            <Link to="/candidates/new">
              <FilePlus2 className="h-4 w-4" />
              採点用紙を登録
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applySearch();
                }}
                placeholder="氏名で検索"
                className="pl-9"
              />
            </div>
            {view === "table" ? (
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="ステータスフィルタ">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="hidden md:block" />
            )}
            <Button variant="outline" onClick={applySearch}>
              検索
            </Button>
          </div>
          {view === "kanban" && canMove && (
            <p className="mt-3 text-xs text-slate-500">
              カードをドラッグして列（ステータス）を移動できます。
            </p>
          )}
        </CardContent>
      </Card>

      {query.isLoading ? (
        view === "kanban" ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-48" />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-12" />
              ))}
            </CardContent>
          </Card>
        )
      ) : !candidates.length ? (
        <Card>
          <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
            <FilePlus2 className="h-10 w-10 text-slate-400" />
            <h2 className="mt-4 text-base font-semibold">候補者がありません</h2>
            <p className="mt-2 max-w-md text-sm text-slate-600">
              採点用紙を登録すると、OCR結果のレビューと判定に進めます。
            </p>
            <Button asChild className="mt-5">
              <Link to="/candidates/new">採点用紙を登録</Link>
            </Button>
          </CardContent>
        </Card>
      ) : view === "kanban" ? (
        <KanbanBoard
          candidates={candidates}
          onMove={handleMove}
          canMove={canMove}
          onDelete={requestDelete}
          canDelete={canDelete}
          onEdit={editCandidate}
          canEdit={canEdit}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>氏名</TableHead>
                  <TableHead>受験日</TableHead>
                  <TableHead>ステータス</TableHead>
                  <TableHead>判定</TableHead>
                  <TableHead>更新</TableHead>
                  {(canEdit || canDelete) && <TableHead className="text-right">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((candidate) => (
                  <TableRow
                    key={candidate.candidateId}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => navigate(`/candidates/${candidate.candidateId}/result`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.click();
                      }
                    }}
                  >
                    <TableCell className="font-medium">{candidate.name}</TableCell>
                    <TableCell>{formatDate(candidate.testDate)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(candidate.status)}>{statusLabels[candidate.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={decisionVariant(candidate.decision)}>
                        {candidate.decision ? decisionLabels[candidate.decision] : "未判定"}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(candidate.updatedAt ?? candidate.uploadedAt)}</TableCell>
                    {(canEdit || canDelete) && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {canEdit && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                editCandidate(candidate);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                              title="候補者情報を編集"
                            >
                              <Pencil className="h-4 w-4" />
                              編集
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={(event) => {
                                event.stopPropagation();
                                requestDelete(candidate);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                              title="候補者を削除"
                            >
                              <Trash2 className="h-4 w-4" />
                              削除
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>候補者を削除しますか</DialogTitle>
            <DialogDescription>
              {deleteTarget?.name} の採点用紙、OCR結果、レビュー、判定結果を削除します。この操作は元に戻せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.candidateId)}
              disabled={!deleteTarget || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              削除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
