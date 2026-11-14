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
  const says = (proposedStatus: ReviewDraft["proposedStatus"], reason = "because") => review({ agrees: false, proposedStatus, reason });
  const tie = (status: "covered" | "not_covered" | "conflict") => ({ status, reason: "settled" });

  it("both say covered → covered, no third reading", () => {
    const r = resolveSecondOpinion(covered, says("covered"), []);
    expect(r).toMatchObject({ status: "covered", thirdReading: false, reviewer: { agrees: true } });
  });
  it("both say not covered → not covered, no third reading", () => {
    expect(resolveSecondOpinion(notCovered, says("not_covered"), [])).toMatchObject({ status: "not_covered", thirdReading: false });
  });

  describe("a disputed 'covered'", () => {
    const objects = says("not_covered", "no in-network language");
    it("asks for a third reading; until there is one, a person decides", () => {
      const r = resolveSecondOpinion(covered, objects, []);
      expect(r).toMatchObject({ status: "needs_review", thirdReading: true, reviewer: { agrees: false, reason: "no in-network language" } });
      expect(r.tieBreak).toBeUndefined();
    });
    it("third reading sides with the reader → covered, with the dispute kept as a flag", () => {
      const r = resolveSecondOpinion(covered, objects, [], tie("covered"));
      expect(r.status).toBe("covered");
      expect(r.flags.map((f) => f.code)).toEqual(["reviewer_disputed"]);
      expect(r.tieBreak).toEqual({ status: "covered", reason: "settled" });
    });
    it("third reading sides with the reviewer → not covered, quotes kept as disputed evidence", () => {
      const r = resolveSecondOpinion(covered, objects, [], tie("not_covered"));
      expect(r.status).toBe("not_covered");
      expect(r.evidence).toHaveLength(1);
      expect(r.flags.find((f) => f.code === "reviewer_disputed")?.detail).toBe("no in-network language");
    });
    it("three different answers → a person decides", () => {
      expect(resolveSecondOpinion(covered, objects, [], tie("conflict")).status).toBe("needs_review");
    });
    it("reviewer and third reading both say conflict → conflict only with the reviewer's own quote", () => {
      expect(resolveSecondOpinion(covered, says("conflict"), [], tie("conflict")).status).toBe("needs_review");
      const r = resolveSecondOpinion(covered, says("conflict"), [ev("III.F.1", 9)], tie("conflict"));
      expect(r.status).toBe("conflict");
      expect(r.evidence.map((e) => e.address)).toEqual(["III.F.1", "II.C.2"]);
    });
  });

  describe("a conflict", () => {
    it("is never reported on two readings alone: it must be confirmed", () => {
      const r = resolveSecondOpinion(conflict, says("conflict"), []);
      expect(r).toMatchObject({ status: "needs_review", thirdReading: true, reviewer: { agrees: true } });
    });
    it("confirmed by the third reading → conflict", () => {
      const r = resolveSecondOpinion(conflict, says("conflict"), [], tie("conflict"));
      expect(r.status).toBe("conflict");
      expect(r.flags).toHaveLength(0);
    });
    it("not confirmed → a person decides, with the reason", () => {
      const r = resolveSecondOpinion(conflict, says("conflict"), [], tie("not_covered"));
      expect(r.status).toBe("needs_review");
      expect(r.flags).toEqual([{ code: "conflict_unconfirmed", detail: "settled" }]);
    });
    it("disputed: upheld two to one → conflict; overturned → the answer the other two share", () => {
      expect(resolveSecondOpinion(conflict, says("not_covered"), [], tie("conflict")).status).toBe("conflict");
      expect(resolveSecondOpinion(conflict, says("not_covered"), [], tie("not_covered")).status).toBe("not_covered");
      expect(resolveSecondOpinion(conflict, says("covered"), [], tie("covered")).status).toBe("covered");
      expect(resolveSecondOpinion(conflict, says("covered"), [], tie("not_covered")).status).toBe("needs_review");
    });
  });

  describe("evidence only the reviewer found", () => {
    const found = [ev("II.A", 1)];
    it("needs a third reading; until there is one, a person decides", () => {
      const r = resolveSecondOpinion(notCovered, says("covered"), found);
      expect(r).toMatchObject({ status: "needs_review", thirdReading: true });
      expect(r.evidence).toHaveLength(1);
      expect(r.flags.map((f) => f.code)).toContain("reviewer_found_evidence");
    });
    it("accepted by the third reading → the reviewer's answer with its quotes", () => {
      expect(resolveSecondOpinion(notCovered, says("covered"), found, tie("covered"))).toMatchObject({ status: "covered", evidence: found });
      expect(resolveSecondOpinion(notCovered, says("conflict"), found, tie("conflict")).status).toBe("conflict");
    });
    it("rejected by the third reading → not covered, the quotes kept as disputed evidence", () => {
      const r = resolveSecondOpinion(notCovered, says("covered"), found, tie("not_covered"));
      expect(r.status).toBe("not_covered");
      expect(r.evidence).toHaveLength(1);
    });
    it("an objection without a verifiable quote changes nothing", () => {
      expect(resolveSecondOpinion(notCovered, says("covered"), [])).toMatchObject({ status: "not_covered", thirdReading: false, reviewer: { agrees: true } });
    });
  });

  describe("a 'covered' that failed an automatic check", () => {
    it("stays with a person, and keeps any new evidence", () => {
      const r = resolveSecondOpinion(needsReview, says("covered"), [ev("II.D", 2)]);
      expect(r).toMatchObject({ status: "needs_review", thirdReading: false });
      expect(r.evidence).toHaveLength(2);
    });
    it("becomes not covered when the reviewer also says it is not covered", () => {
      const r = resolveSecondOpinion(needsReview, says("not_covered"), []);
      expect(r.status).toBe("not_covered");
      expect(r.flags.map((f) => f.code)).toEqual(["reviewer_disputed"]);
    });
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
