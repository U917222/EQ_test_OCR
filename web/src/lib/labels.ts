import type { BadgeProps } from "@/components/ui/badge";
import type { CandidateStatus, Decision } from "@/lib/types";

export const statusLabels: Record<CandidateStatus, string> = {
  uploaded: "応募済み",
  recognizing: "履歴書提出済み",
  needs_review: "面接選考済み",
  scored: "評価待ち",
  finalized: "結果",
};

export const decisionLabels: Record<Decision, string> = {
  hire: "合格",
  reject: "不合格",
};

export function statusVariant(status: CandidateStatus): BadgeProps["variant"] {
  switch (status) {
    case "needs_review":
      return "warning";
    case "scored":
    case "finalized":
      return "success";
    case "recognizing":
      return "info";
    default:
      return "neutral";
  }
}

export function decisionVariant(decision?: Decision): BadgeProps["variant"] {
  switch (decision) {
    case "hire":
      return "success";
    case "reject":
      return "destructive";
    default:
      return "outline";
  }
}

export function confidenceTone(confidence: number) {
  if (confidence >= 0.85) return "emerald";
  if (confidence >= 0.6) return "amber";
  return "red";
}

export function rankVariant(rank: string): BadgeProps["variant"] {
  switch (rank) {
    case "A":
      return "success";
    case "B":
      return "info";
    case "C":
      return "warning";
    case "D":
      return "destructive";
    default:
      return "neutral";
  }
}

export function stageTone(stage: number): "red" | "amber" | "emerald" {
  if (stage >= 4) return "emerald";
  if (stage === 3) return "amber";
  return "red";
}
