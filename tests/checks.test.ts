import { describe, expect, it } from "vitest";
import { checkItem, verifyEvidence } from "../src/pipeline/checks";
import type { ReaderDraft } from "../src/types";
import { APL_25_008, item, policyMap } from "./helpers";

const ctx = { policies: policyMap("GG.1503", "MA.6113"), regulator: APL_25_008 };
const draft = (over: Partial<ReaderDraft>): ReaderDraft => ({ itemId: "Q1-01", status: "covered", wording: "same", evidence: [], reason: "", ...over });

describe("Step 12 automatic checks", () => {
  it("removes a quote from the Medicare-only section as the wrong program", () => {
    const r = checkItem(
      item({ id: "Q10-04" }),
      draft({ evidence: [{ policyId: "GG.1503", quote: "other Medicare-covered treatments for the Terminal Illness and related conditions" }] }),
      ctx,
    );
    expect(r.evidence).toHaveLength(0);
    expect(r.status).toBe("not_covered");
    expect(r.flags.map((f) => f.code)).toContain("wrong_program_removed");
  });

  it("removes evidence from a policy that does not apply to Medi-Cal", () => {
    const ma = ctx.policies.get("MA.6113")!;
    const sentence = ma.canonicalText.slice(ma.spans[1].start, ma.spans[1].end);
    const r = checkItem(item({ id: "Q1-01" }), draft({ evidence: [{ policyId: "MA.6113", quote: sentence }] }), ctx);
    expect(r.evidence).toHaveLength(0);
    expect(r.status).toBe("not_covered");
    expect(r.flags.map((f) => f.code)).toContain("wrong_program_removed");
  });

  it("drops made-up quotes, so an unsupported 'covered' becomes not covered", () => {
    const r = checkItem(item({ id: "Q11-01" }), draft({ evidence: [{ policyId: "GG.1503", quote: "The election form must be submitted within five calendar days." }] }), ctx);
    expect(r.status).toBe("not_covered");
    expect(r.evidence).toHaveLength(0);
  });

  it("flags 5 days against thirty (30) days and sends a 'covered' to review", () => {
    const r = checkItem(
      item({ id: "Q11-01", quantities: [{ value: 5, unit: "calendar day", unitBase: "day" }] }),
      draft({ evidence: [{ policyId: "GG.1503", quote: "no later than thirty (30) calendar days after start of services" }] }),
      ctx,
    );
    expect(r.status).toBe("needs_review");
    const flag = r.flags.find((f) => f.code === "number_mismatch");
    expect(flag?.detail).toContain("5 calendar days");
    expect(flag?.detail).toContain("30 calendar days");
  });

  it("keeps a reader's 'conflict' and still records the number mismatch", () => {
    const r = checkItem(
      item({ id: "Q11-01", quantities: [{ value: 5, unit: "calendar day", unitBase: "day" }] }),
      draft({ status: "conflict", evidence: [{ policyId: "GG.1503", quote: "no later than thirty (30) calendar days after start of services" }] }),
      ctx,
    );
    expect(r.status).toBe("conflict");
    expect(r.flags.map((f) => f.code)).toContain("number_mismatch");
  });

  it("accepts a matching number written differently", () => {
    const r = checkItem(
      item({ id: "Q10-03", quantities: [{ value: 6, unit: "month", unitBase: "month" }] }),
      draft({ evidence: [{ policyId: "GG.1503", quote: "life expectancy is six (6) months or less if the disease is to run its normal course" }] }),
      ctx,
    );
    expect(r.status).toBe("covered");
    expect(r.flags.filter((f) => f.code.startsWith("number"))).toHaveLength(0);
  });

  it("flags a required number that the quote does not show", () => {
    const r = checkItem(
      item({ id: "Q45-01", quantities: [{ value: 95, unit: "percent", unitBase: "percent" }] }),
      draft({ evidence: [{ policyId: "GG.1503", quote: "Room and Board coverage for a Member residing in a Long-Term Care (LTC) facility" }] }),
      ctx,
    );
    expect(r.status).toBe("needs_review");
    expect(r.flags.map((f) => f.code)).toContain("number_not_shown");
  });

  it("warns that GG.1503 predates the APL and cites the APL it replaced", () => {
    const r = checkItem(item({ id: "Q10-01" }), draft({ evidence: [{ policyId: "GG.1503", quote: "certifies the Member’s illness is terminal" }] }), ctx);
    expect(r.status).toBe("covered");
    const codes = r.flags.map((f) => f.code);
    expect(codes).toContain("policy_predates_apl");
    expect(codes).toContain("cites_superseded_apl");
  });

  it("flags equivalent wording without changing the status", () => {
    const r = checkItem(
      item({ id: "Q10-02" }),
      draft({ wording: "equivalent", reason: '"hospice physician" for "hospice medical director"', evidence: [{ policyId: "GG.1503", quote: "A hospice physician (and attending physician, if any) certifies" }] }),
      ctx,
    );
    expect(r.status).toBe("covered");
    expect(r.flags.find((f) => f.code === "wording_differs")?.detail).toContain("hospice physician");
  });

  it("counts the References section only for 'may reference' items", () => {
    const quote = "California Children’s Services (CCS) Numbered Letter 12-1119: Palliative Care Options for CCS";
    const normal = verifyEvidence(item({ id: "Q35-01" }), [{ policyId: "GG.1503", quote }], ctx);
    const mayRef = verifyEvidence(item({ id: "Q35-02", allowsReference: true }), [{ policyId: "GG.1503", quote }], ctx);
    expect(normal.evidence).toHaveLength(0);
    expect(mayRef.evidence).toHaveLength(1);
    expect(mayRef.evidence[0].kind).toBe("references");
  });

  it("marks a corrected quote and stores the source wording", () => {
    const r = verifyEvidence(
      item({ id: "Q11-01" }),
      [{ policyId: "GG.1503", quote: "A Hospice Provider must submit Notification of Hospice election immediately and no later than thirty (30) calendar days after the start of services" }],
      ctx,
    );
    expect(r.evidence[0].status).toBe("corrected");
    expect(r.evidence[0].quote).toContain("shall submit");
    expect(r.flags.map((f) => f.code)).toContain("quote_corrected");
  });
});
