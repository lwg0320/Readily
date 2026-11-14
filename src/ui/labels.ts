// The words the interface uses for the pipeline's codes.
import type { FlagCode, ItemStatus, Verdict } from "../types";

export const VERDICT_LABEL: Record<Verdict, string> = {
  conflict: "Conflict",
  needs_review: "Needs review",
  partial: "Partly covered",
  not_found: "Not found",
  covered: "Covered",
};

export const VERDICT_HELP: Record<Verdict, string> = {
  conflict: "A policy sets a different rule from what DHCS requires.",
  needs_review: "The checks could not settle this. Your call.",
  partial: "Some parts of the question are in your policies, some are not.",
  not_found: "No Medi-Cal policy states this.",
  covered: "Your policies state every part of the question.",
};

/** The longer explanation behind the info button: what the verdict means and what to do with it. */
export const VERDICT_MEANING: Record<Verdict, string> = {
  conflict:
    "A policy sets a different rule from what DHCS requires, for example 30 days where DHCS says 5. It is only reported after a third reading confirms it. Suggested answer: No. The policy probably needs changing.",
  needs_review:
    "The checks could not settle it: the readings disagreed with each other, or an automatic check failed (for example, a number DHCS requires is missing from the quote). No answer is suggested. Look at the evidence and decide.",
  partial:
    "The question asks for several things. Your policies state some of them and not the others. No answer is suggested: if DHCS needs every part, the answer is No.",
  not_found:
    "No Medi-Cal policy states any part of this. Every policy was read, and each question shows what was searched for and the closest passage. Suggested answer: No.",
  covered:
    "Your policies state every part of the question. Each part has an exact quote with its section and page, and a second opinion agreed. Suggested answer: Yes.",
};

export const VERDICT_ORDER: Verdict[] = ["conflict", "needs_review", "partial", "not_found", "covered"];

export const STATUS_LABEL: Record<ItemStatus, string> = {
  covered: "Stated in policy",
  not_covered: "Not stated",
  conflict: "Conflicts with policy",
  needs_review: "Needs your review",
};

export const FLAG_LABEL: Record<FlagCode, string> = {
  wording_differs: "wording differs",
  number_mismatch: "numbers differ",
  number_not_shown: "number not shown",
  reviewer_disputed: "second opinion disagreed",
  reviewer_found_evidence: "second opinion found evidence",
  conflict_unconfirmed: "conflict not confirmed",
  policies_disagree: "policies may disagree",
  policy_predates_apl: "policy may be outdated",
  cites_superseded_apl: "policy may be outdated",
  quote_corrected: "quote corrected",
  wrong_program_removed: "non-Medi-Cal text removed",
  list_count_mismatch: "list may be incomplete",
  analysis_failed: "could not be analysed",
};

/**
 * Flags worth showing on a results row, most important first, without repeats.
 * "Wording differs" and "policy may be outdated" are left to the question's own page: on a real
 * run they applied to most rows, which made every row look the same. Outdated policies are
 * summarised once, above the list.
 */
export function rowFlags(codes: FlagCode[]): string[] {
  const order: FlagCode[] = [
    "analysis_failed",
    "number_mismatch",
    "policies_disagree",
    "conflict_unconfirmed",
    "reviewer_disputed",
    "reviewer_found_evidence",
    "number_not_shown",
    "list_count_mismatch",
    "wrong_program_removed",
    "quote_corrected",
  ];
  const have = new Set(codes);
  return [...new Set(order.filter((c) => have.has(c)).map((c) => FLAG_LABEL[c]))];
}
