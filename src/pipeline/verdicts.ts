// Steps 13 (resolution) and 15 — verdicts (ARCHITECTURE.md §8). Plain code.
import type { Evidence, Flag, ItemResult, ItemStatus, ParentResult, ReviewDraft, TieBreak, Verdict } from "../types";
import type { CheckedItem } from "./checks";

export type Resolution = {
  status: ItemStatus;
  evidence: Evidence[];
  flags: Flag[];
  reviewer: ItemResult["reviewer"];
  /** True when a third reading is needed to settle or confirm the answer. */
  thirdReading: boolean;
  tieBreak?: TieBreak;
};

/**
 * Combines the checked full reading (A), the second opinion (B) and, when one was needed, the
 * third reading (C). Call it once without C to learn whether a third reading is needed; without
 * one, those cases go to a person.
 *
 * - A and B agree on "covered" or "not covered": that answer stands.
 * - A and B disagree: the answer that C shares with one of them stands. No two agree: a person decides.
 * - A "conflict" is only reported when C confirms it, even if A and B agree.
 * - Evidence only B found counts once C accepts it.
 */
export function resolveSecondOpinion(
  checked: CheckedItem,
  review: ReviewDraft | null,
  verifiedNewEvidence: Evidence[],
  tieBreak: TieBreak | null = null,
): Resolution {
  const flags = [...checked.flags];
  if (!review) return { status: checked.status, evidence: [...checked.evidence], flags, reviewer: null, thirdReading: false };

  const a = checked.status;
  const b = review.proposedStatus;
  const c = tieBreak?.status ?? null;
  const merge = (first: Evidence[], second: Evidence[]) => {
    const have = new Set(first.map((e) => `${e.policyId}|${e.quote}`));
    return [...first, ...second.filter((e) => !have.has(`${e.policyId}|${e.quote}`))];
  };

  let status: ItemStatus = a;
  let evidence = [...checked.evidence];
  let thirdReading = false;
  // for the three real answers, agreeing means giving the same one
  let agrees = a === "needs_review" ? review.agrees : a === b;

  if (a === "needs_review") {
    // the reader said "covered" but an automatic check failed
    if (b === "not_covered") {
      status = "not_covered"; // quotes are kept and shown as disputed evidence
      flags.push({ code: "reviewer_disputed", detail: review.reason });
    } else evidence = merge(evidence, verifiedNewEvidence);
  } else if (a === "not_covered") {
    if (b !== "not_covered" && verifiedNewEvidence.length) {
      thirdReading = true;
      evidence = verifiedNewEvidence;
      flags.push({ code: "reviewer_found_evidence", detail: review.reason });
      status = c === b ? b : c === "not_covered" ? "not_covered" : "needs_review";
    } else agrees = true; // an objection without a verifiable quote changes nothing
  } else if (a === b) {
    if (a === "conflict") {
      thirdReading = true;
      if (c !== "conflict") {
        status = "needs_review";
        if (tieBreak) flags.push({ code: "conflict_unconfirmed", detail: tieBreak.reason });
      }
    }
  } else {
    thirdReading = true;
    flags.push({ code: "reviewer_disputed", detail: review.reason });
    if (c === a) {
      // upheld two to one (a conflict is thereby confirmed too); the dispute stays visible as a flag
    } else if (c === b && b === "not_covered") {
      status = "not_covered"; // quotes are kept and shown as disputed evidence
    } else if (c === b && b === "covered") {
      status = "covered"; // the text the reader took for a conflict states the requirement after all
      evidence = merge(evidence, verifiedNewEvidence);
    } else if (c === b && verifiedNewEvidence.length) {
      status = "conflict"; // needs the reviewer's own quote of the conflicting text
      evidence = merge(verifiedNewEvidence, evidence);
    } else status = "needs_review";
  }

  return { status, evidence, flags, reviewer: { agrees, reason: review.reason }, thirdReading, ...(thirdReading && tieBreak ? { tieBreak } : {}) };
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
