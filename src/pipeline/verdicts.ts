// Steps 13 (resolution) and 15 — verdicts (ARCHITECTURE.md §8). Plain code.
import type { Evidence, Flag, ItemResult, ItemStatus, ParentResult, ReviewDraft, TieBreak, Verdict } from "../types";
import type { CheckedItem } from "./checks";

/** The full reading said "covered" or "conflict" and the second opinion disagrees: a third reading settles it. */
export function isDisputed(checked: CheckedItem, review: ReviewDraft | null): boolean {
  return !!review && !review.agrees && (checked.status === "covered" || checked.status === "conflict");
}

/**
 * Combines the checked first reading with the second opinion and, where they disagreed, the
 * tie-break. An answer stands when two of the three readings give it; otherwise a person
 * decides. Missed evidence found by the reviewer always goes to a person.
 */
export function resolveSecondOpinion(
  checked: CheckedItem,
  review: ReviewDraft | null,
  verifiedNewEvidence: Evidence[],
  tieBreak: TieBreak | null = null,
): { status: ItemStatus; evidence: Evidence[]; flags: Flag[]; reviewer: ItemResult["reviewer"]; tieBreak?: TieBreak } {
  const flags = [...checked.flags];
  let evidence = [...checked.evidence];
  let status = checked.status;
  if (!review) return { status, evidence, flags, reviewer: null };

  const addNew = () => {
    const have = new Set(evidence.map((e) => `${e.policyId}|${e.quote}`));
    evidence = [...evidence, ...verifiedNewEvidence.filter((e) => !have.has(`${e.policyId}|${e.quote}`))];
  };

  switch (checked.status) {
    case "covered":
    case "conflict":
      if (!review.agrees) {
        flags.push({ code: "reviewer_disputed", detail: review.reason });
        if (tieBreak?.status === checked.status) {
          // upheld two to one; the dispute stays visible as a flag
        } else if (tieBreak?.status === "not_covered" && review.proposedStatus === "not_covered") {
          status = "not_covered"; // quotes are kept and shown as disputed evidence
        } else {
          status = "needs_review"; // three different answers, or no tie-break
        }
      }
      break;
    case "not_covered":
      if (!review.agrees && verifiedNewEvidence.length) {
        status = "needs_review";
        addNew();
        flags.push({ code: "reviewer_found_evidence", detail: review.reason });
      }
      break;
    case "needs_review":
      if (verifiedNewEvidence.length) addNew();
      break;
  }
  const settled = isDisputed(checked, review) && tieBreak ? { tieBreak } : {};
  return { status, evidence, flags, reviewer: { agrees: review.agrees, reason: review.reason }, ...settled };
}

/** Step 15: one verdict per question or obligation, from its items. First match wins. */
export function verdictFor(items: { status: ItemStatus }[]): Verdict {
  if (!items.length) return "needs_review";
  if (items.some((i) => i.status === "conflict")) return "conflict";
  if (items.some((i) => i.status === "needs_review")) return "needs_review";
  if (items.every((i) => i.status === "not_covered")) return "not_found";
  if (items.every((i) => i.status === "covered")) return "covered";
  return "partial";
}

export function suggestedAnswerFor(verdict: Verdict): "yes" | "no" | null {
  if (verdict === "covered") return "yes";
  if (verdict === "conflict" || verdict === "not_found") return "no";
  return null;
}

export function formatCitation(e: { policyId: string; address: string; page: number }): string {
  const where = e.address.startsWith("Glossary: ") ? `Glossary "${e.address.slice(10)}"` : `§${e.address}`;
  return `${e.policyId} ${where}, p.${e.page}`;
}

/** Every distinct citation of the covered items, shortest address first. */
export function allCitations(items: ItemResult[]): string[] {
  const seen = new Map<string, number>();
  for (const it of items) {
    if (it.status !== "covered" || !it.evidence.length) continue;
    const e = it.evidence[0];
    const c = formatCitation(e);
    if (!seen.has(c)) seen.set(c, e.address.length);
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}

/** The form's citation field is one line: whole citations only, under `maxChars`. */
export function suggestedCitationFor(items: ItemResult[], maxChars = 90): string {
  const out: string[] = [];
  let length = 0;
  for (const c of allCitations(items)) {
    const add = (out.length ? 2 : 0) + c.length;
    if (length + add > maxChars) break;
    out.push(c);
    length += add;
  }
  return out.join("; ");
}

export function buildParentResult(parentId: string, items: ItemResult[], previous?: ParentResult): ParentResult {
  const verdict = verdictFor(items);
  return {
    parentId,
    verdict,
    items,
    suggestedAnswer: suggestedAnswerFor(verdict),
    suggestedCitation: suggestedCitationFor(items),
    approved: previous?.approved ?? false,
    edited: previous?.edited,
    followUp: previous?.followUp,
  };
}

const VERDICT_ORDER: Verdict[] = ["conflict", "needs_review", "partial", "not_found", "covered"];

export function flagCount(r: ParentResult): number {
  return r.items.reduce((n, i) => n + i.flags.length, 0);
}

/** Riskiest first: by verdict, then more flags first, then in document order. */
export function sortByRisk(results: ParentResult[]): ParentResult[] {
  const num = (id: string) => {
    const m = id.match(/\d+/g);
    return m ? Number(m[m.length - 1]) : 0;
  };
  return [...results].sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) ||
      flagCount(b) - flagCount(a) ||
      num(a.parentId) - num(b.parentId) ||
      a.parentId.localeCompare(b.parentId),
  );
}
