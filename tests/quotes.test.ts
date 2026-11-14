import { describe, expect, it } from "vitest";
import { verifyQuote } from "../src/lib/quotes";
import { loadPolicy } from "./helpers";

const gg = loadPolicy("GG.1503");

describe("verifyQuote on GG.1503", () => {
  it("finds an exact quote and reports its page, address and program", () => {
    const v = verifyQuote(gg, "certifies the Member’s illness is terminal (life expectancy is six (6) months or less if the disease is to run its normal course)");
    expect(v.status).toBe("exact");
    if (v.status === "rejected") return;
    expect(v.address).toBe("II.C.2");
    expect(v.page).toBe(2);
    expect(v.scope).toBe("medi-cal");
  });

  it("ignores differences in quotes, dashes, line breaks and case", () => {
    const v = verifyQuote(gg, "  \"CERTIFIES the Member's   illness is terminal\"  ");
    expect(v.status).toBe("exact");
  });

  it("returns the policy's own words, not the model's", () => {
    const v = verifyQuote(gg, "no later than THIRTY (30) calendar days after start of services");
    expect(v.status).toBe("exact");
    if (v.status === "rejected") return;
    expect(v.text).toBe("no later than thirty (30) calendar days after start of services");
    expect(v.address).toBe("III.F.1");
  });

  it("tags the Medicare-only section as another program", () => {
    const v = verifyQuote(gg, "other Medicare-covered treatments for the Terminal Illness and related conditions");
    expect(v.status).toBe("exact");
    if (v.status === "rejected") return;
    expect(v.address).toBe("II.B.4");
    expect(v.scope).toBe("other");
  });

  it("prefers the Medi-Cal occurrence when the same sentence appears under both programs", () => {
    const v = verifyQuote(gg, "understands and accepts care primarily for comfort (palliative) instead of care to cure the illness (curative)");
    expect(v.status).toBe("exact");
    if (v.status === "rejected") return;
    expect(v.address).toBe("II.C.3");
    expect(v.scope).toBe("medi-cal");
  });

  it("matches a glossary quote that crosses a page break", () => {
    const v = verifyQuote(gg, "in lieu of curative treatment related to the terminal condition, by a Hospice Provider or by others under arrangements made by a Hospice Provider");
    expect(v.status).toBe("exact");
    if (v.status === "rejected") return;
    expect(v.address).toBe("Glossary: Hospice Care");
    expect(v.kind).toBe("glossary");
  });

  it("corrects a near miss to the source text", () => {
    const v = verifyQuote(gg, "A Hospice Provider must submit Notification of Hospice election immediately and no later than thirty (30) calendar days after the start of services");
    expect(v.status).toBe("corrected");
    if (v.status === "rejected") return;
    expect(v.text).toContain("shall submit Notification of Hospice election immediately and no later than thirty (30) calendar days");
    expect(v.address).toBe("III.F.1");
  });

  it("rejects text that is not in the policy", () => {
    expect(verifyQuote(gg, "The hospice Provider must submit the election form within five calendar days of certification").status).toBe("rejected");
    expect(verifyQuote(gg, "MCPs may restrict coverage to in-Network Providers").status).toBe("rejected");
    expect(verifyQuote(gg, "x").status).toBe("rejected");
  });
});
