import { describe, expect, it } from "vitest";
import { allCitations, buildParentResult, resolveSecondOpinion, sortByRisk, suggestedAnswerFor, suggestedCitationFor, verdictFor } from "../src/pipeline/verdicts";
import type { Evidence, ItemResult, ItemStatus, ReviewDraft } from "../src/types";
import { item } from "./helpers";

const ev = (address: string, page: number, policyId = "GG.1503"): Evidence => ({ policyId, quote: `quote at ${address}`, page, address, kind: "body", scope: "both", status: "exact" });
const res = (id: string, status: ItemStatus, evidence: Evidence[] = [], flags: ItemResult["flags"] = []): ItemResult => ({ item: item({ id }), status, evidence, readerReason: "", reviewer: null, flags });
const review = (over: Partial<ReviewDraft>): ReviewDraft => ({ itemId: "Q1-01", agrees: true, proposedStatus: "covered", reason: "because", newEvidence: [], ...over });
const st = (...s: ItemStatus[]) => s.map((status) => ({ status }));

describe("verdictFor (Step 15)", () => {
  it("follows the verdict table, first match wins", () => {
    expect(verdictFor(st("covered", "conflict", "needs_review"))).toBe("conflict");
    expect(verdictFor(st("covered", "needs_review", "not_covered"))).toBe("needs_review");
    expect(verdictFor(st("not_covered", "not_covered"))).toBe("not_found");
    expect(verdictFor(st("covered", "not_covered"))).toBe("partial");
    expect(verdictFor(st("covered", "covered"))).toBe("covered");
  });
  it("never calls an empty result covered", () => {
    expect(verdictFor([])).toBe("needs_review");
  });
  it("suggests Yes only for covered, No for conflict and not found, nothing otherwise", () => {
    expect(suggestedAnswerFor("covered")).toBe("yes");
    expect(suggestedAnswerFor("conflict")).toBe("no");
    expect(suggestedAnswerFor("not_found")).toBe("no");
    expect(suggestedAnswerFor("partial")).toBeNull();
    expect(suggestedAnswerFor("needs_review")).toBeNull();
  });
});

describe("resolveSecondOpinion (Step 13)", () => {
  const covered = { status: "covered" as const, evidence: [ev("II.C.2", 2)], flags: [] };
  const conflict = { status: "conflict" as const, evidence: [ev("III.F.1", 9)], flags: [] };
  const notCovered = { status: "not_covered" as const, evidence: [], flags: [] };
  const needsReview = { status: "needs_review" as const, evidence: [ev("III.F.1", 9)], flags: [] };

  it("covered + agrees → covered", () => {
    expect(resolveSecondOpinion(covered, review({}), []).status).toBe("covered");
  });
  it("covered + disagrees → not covered, quotes kept as disputed evidence", () => {
    const r = resolveSecondOpinion(covered, review({ agrees: false, reason: "no in-network language" }), []);
    expect(r.status).toBe("not_covered");
    expect(r.evidence).toHaveLength(1);
    expect(r.flags.find((f) => f.code === "reviewer_disputed")?.detail).toBe("no in-network language");
    expect(r.reviewer).toEqual({ agrees: false, reason: "no in-network language" });
  });
  it("conflict + agrees → conflict; conflict + disagrees → needs review", () => {
    expect(resolveSecondOpinion(conflict, review({}), []).status).toBe("conflict");
    expect(resolveSecondOpinion(conflict, review({ agrees: false }), []).status).toBe("needs_review");
  });
  it("not covered + agrees → not covered", () => {
    expect(resolveSecondOpinion(notCovered, review({}), []).status).toBe("not_covered");
  });
  it("not covered + reviewer found verified evidence → needs review with that evidence", () => {
    const r = resolveSecondOpinion(notCovered, review({ agrees: false }), [ev("II.A", 1)]);
    expect(r.status).toBe("needs_review");
    expect(r.evidence).toHaveLength(1);
    expect(r.flags.map((f) => f.code)).toContain("reviewer_found_evidence");
  });
  it("not covered + reviewer disagrees without verified evidence → not covered", () => {
    expect(resolveSecondOpinion(notCovered, review({ agrees: false }), []).status).toBe("not_covered");
  });
  it("needs review stays needs review and keeps any new evidence", () => {
    const r = resolveSecondOpinion(needsReview, review({}), [ev("II.D", 2)]);
    expect(r.status).toBe("needs_review");
    expect(r.evidence).toHaveLength(2);
  });
  it("without a second opinion the checked result stands", () => {
    const r = resolveSecondOpinion(covered, null, []);
    expect(r.status).toBe("covered");
    expect(r.reviewer).toBeNull();
  });
});

describe("citations", () => {
  const items = [
    res("Q10-01", "covered", [ev("II.C.2", 2)]),
    res("Q10-02", "covered", [ev("III.A.1", 7)]),
    res("Q10-03", "covered", [ev("Glossary: Terminally Ill", 18)]),
    res("Q10-04", "not_covered", [ev("II.B.4", 2)]),
    res("Q10-05", "covered", [ev("II.C.2", 2)]),
  ];
  it("lists distinct citations of covered items only, shortest address first", () => {
    expect(allCitations(items)).toEqual(["GG.1503 §II.C.2, p.2", "GG.1503 §III.A.1, p.7", 'GG.1503 Glossary "Terminally Ill", p.18']);
  });
  it("fits whole citations into the form's one-line field and never cuts one", () => {
    expect(suggestedCitationFor(items, 45)).toBe("GG.1503 §II.C.2, p.2; GG.1503 §III.A.1, p.7");
    expect(suggestedCitationFor(items, 30)).toBe("GG.1503 §II.C.2, p.2");
    expect(suggestedCitationFor(items)).toContain("Terminally Ill");
  });
});

describe("buildParentResult and sortByRisk", () => {
  it("builds a result and keeps earlier approval and edits", () => {
    const first = buildParentResult("25", [res("Q25-01", "covered", [ev("II.A", 1)]), res("Q25-02", "not_covered")]);
    expect(first.verdict).toBe("partial");
    expect(first.suggestedAnswer).toBeNull();
    expect(first.approved).toBe(false);
    const again = buildParentResult("25", first.items, { ...first, approved: true, edited: { answer: "no", citation: "x" } });
    expect(again.approved).toBe(true);
    expect(again.edited?.answer).toBe("no");
  });
  it("sorts riskiest first, then more flags, then question number", () => {
    const flag = { code: "wording_differs" as const, detail: "" };
    const results = [
      buildParentResult("3", [res("Q3-01", "covered", [ev("II.A", 1)])]),
      buildParentResult("10", [res("Q10-01", "covered", [ev("II.A", 1)], [flag])]),
      buildParentResult("7", [res("Q7-01", "not_covered")]),
      buildParentResult("11", [res("Q11-01", "conflict", [ev("III.F.1", 9)])]),
      buildParentResult("25", [res("Q25-01", "covered", [ev("II.A", 1)]), res("Q25-02", "not_covered")]),
      buildParentResult("2", [res("Q2-01", "needs_review", [ev("II.A", 1)])]),
    ];
    expect(sortByRisk(results).map((r) => r.parentId)).toEqual(["11", "2", "25", "7", "10", "3"]);
  });
});
