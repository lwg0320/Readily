// Comparing two runs of the same questionnaire (ARCHITECTURE.md §10.3, "Show differences").
import type { ParentResult } from "../types";

export type Difference = { parentId: string; a: ParentResult; b: ParentResult };

/** Questions whose verdict differs between run A and run B, in question order. */
export function differences(a: ParentResult[], b: ParentResult[]): { changed: Difference[]; same: number; onlyInA: string[]; onlyInB: string[] } {
  const inB = new Map(b.map((r) => [r.parentId, r]));
  const inA = new Set(a.map((r) => r.parentId));
  const changed: Difference[] = [];
  let same = 0;
  for (const ra of a) {
    const rb = inB.get(ra.parentId);
    if (!rb) continue;
    if (ra.verdict === rb.verdict) same++;
    else changed.push({ parentId: ra.parentId, a: ra, b: rb });
  }
  const byNumber = (x: string, y: string) => Number(x) - Number(y) || x.localeCompare(y);
  changed.sort((x, y) => byNumber(x.parentId, y.parentId));
  return {
    changed,
    same,
    onlyInA: a.filter((r) => !inB.has(r.parentId)).map((r) => r.parentId).sort(byNumber),
    onlyInB: b.filter((r) => !inA.has(r.parentId)).map((r) => r.parentId).sort(byNumber),
  };
}
