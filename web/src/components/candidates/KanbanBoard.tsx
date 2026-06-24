import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GripVertical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { decisionLabels, decisionVariant, statusLabels, statusVariant } from "@/lib/labels";
import { Candidate, CandidateStatus } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

const COLUMNS: CandidateStatus[] = [
  "uploaded",
  "recognizing",
  "needs_review",
  "scored",
  "finalized",
];
const INITIAL_VISIBLE_ITEMS = 40;
const VISIBLE_ITEMS_STEP = 40;

type Props = {
  candidates: Candidate[];
  onMove: (candidateId: string, toStatus: CandidateStatus) => void;
  canMove: boolean;
  onDelete?: (candidate: Candidate) => void;
  canDelete?: boolean;
};

export function KanbanBoard({ candidates, onMove, canMove, onDelete, canDelete = false }: Props) {
  const navigate = useNavigate();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<CandidateStatus | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<Record<CandidateStatus, number>>(() => defaultVisibleCounts());

  const hrefFor = (candidate: Candidate) => `/candidates/${candidate.candidateId}/result`;

  const groups = useMemo(() => {
    const byStatus = new Map<CandidateStatus, Candidate[]>(COLUMNS.map((status) => [status, []]));
    for (const candidate of candidates) {
      if (byStatus.has(candidate.status)) byStatus.get(candidate.status)?.push(candidate);
    }
    return COLUMNS.map((status) => ({
      status,
      items: byStatus.get(status) ?? [],
    }));
  }, [candidates]);

  useEffect(() => {
    setVisibleCounts(defaultVisibleCounts());
  }, [candidates]);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      {groups.map((group) => (
        <section
          key={group.status}
          onDragOver={(event) => {
            if (!canMove || !dragId) return;
            event.preventDefault();
            setOverColumn(group.status);
          }}
          onDragLeave={() =>
            setOverColumn((prev) => (prev === group.status ? null : prev))
          }
          onDrop={(event) => {
            event.preventDefault();
            if (canMove && dragId) onMove(dragId, group.status);
            setDragId(null);
            setOverColumn(null);
          }}
          className={cn(
            "flex min-h-[200px] flex-col rounded-lg border border-slate-200 bg-slate-50/70 transition-colors",
            overColumn === group.status && "border-indigo-300 bg-indigo-50/70 ring-2 ring-indigo-300",
          )}
        >
          <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <Badge variant={statusVariant(group.status)}>{statusLabels[group.status]}</Badge>
            <span className="text-xs font-medium text-slate-500">{group.items.length}</span>
          </header>

          <div className="flex flex-1 flex-col gap-2 p-2">
            {group.items.slice(0, visibleCounts[group.status]).map((candidate) => (
              <article
                key={candidate.candidateId}
                draggable={canMove}
                onDragStart={() => setDragId(candidate.candidateId)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverColumn(null);
                }}
                onClick={() => navigate(hrefFor(candidate))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") navigate(hrefFor(candidate));
                }}
                tabIndex={0}
                role="button"
                className={cn(
                  "group cursor-pointer rounded-md border border-slate-200 bg-white p-3 shadow-sm transition hover:border-indigo-300 hover:shadow",
                  dragId === candidate.candidateId && "opacity-50",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{candidate.name}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {formatDate(candidate.testDate)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canDelete && onDelete && (
                      <button
                        type="button"
                        className="rounded-md p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-300"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(candidate);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                        title="候補者を削除"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">候補者を削除</span>
                      </button>
                    )}
                    {canMove && (
                      <GripVertical className="h-4 w-4 text-slate-300 group-hover:text-slate-400" />
                    )}
                  </div>
                </div>
                {candidate.decision && (
                  <div className="mt-2">
                    <Badge variant={decisionVariant(candidate.decision)}>
                      {decisionLabels[candidate.decision]}
                    </Badge>
                  </div>
                )}
              </article>
            ))}

            {group.items.length > visibleCounts[group.status] && (
              <button
                type="button"
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                onClick={() =>
                  setVisibleCounts((current) => ({
                    ...current,
                    [group.status]: Math.min(group.items.length, current[group.status] + VISIBLE_ITEMS_STEP),
                  }))
                }
              >
                さらに表示（残り {group.items.length - visibleCounts[group.status]} 件）
              </button>
            )}

            {!group.items.length && (
              <p className="px-2 py-8 text-center text-xs text-slate-400">なし</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function defaultVisibleCounts(): Record<CandidateStatus, number> {
  return {
    uploaded: INITIAL_VISIBLE_ITEMS,
    recognizing: INITIAL_VISIBLE_ITEMS,
    needs_review: INITIAL_VISIBLE_ITEMS,
    scored: INITIAL_VISIBLE_ITEMS,
    finalized: INITIAL_VISIBLE_ITEMS,
  };
}
