import { CellKey, ScoreCell } from "@/lib/types";

export function areAllCellsEmpty(cells: ScoreCell[], edited?: Partial<Record<CellKey, number | null>>): boolean {
  return !cells.some((cell) => {
    const value = edited && cell.key in edited ? edited[cell.key] : cell.value ?? cell.detectedValue;
    return typeof value === "number" && Number.isFinite(value);
  });
}
