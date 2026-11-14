import { beforeAll, describe, expect, it } from "vitest";
import { createSearch, type Search } from "../src/lib/search";
import { loadPolicy, loadSearchIndex } from "./helpers";

let search: Search;
beforeAll(() => {
  search = createSearch(["GG.1503", "GG.1422", "GG.1355", "MA.6113", "GG.1655"].map(loadPolicy), loadSearchIndex());
});

describe("exactSearch", () => {
  it("finds a number however it is written", () => {
    const hits = search.exactSearch("thirty calendar days", { mediCalOnly: true });
    const gg = hits.filter((h) => h.policyId === "GG.1503");
    expect(gg.length).toBeGreaterThan(0);
    expect(gg.some((h) => h.address === "III.F.1")).toBe(true);
    expect(search.exactSearch("30 calendar days").some((h) => h.policyId === "GG.1422")).toBe(true);
  });
  it("finds a code, as a whole word only", () => {
    const hits = search.exactSearch("0657");
    expect(hits.some((h) => h.policyId === "GG.1503")).toBe(true);
    expect(search.exactSearch("065")).toHaveLength(0);
  });
  it("proves a term is absent", () => {
    expect(search.exactSearch("Transitional Rent")).toHaveLength(0);
    expect(search.exactSearch("streamlined authorization")).toHaveLength(0);
  });
  it("respects the Medi-Cal filter", () => {
    expect(search.exactSearch("Part D").some((h) => h.policyId === "MA.6113")).toBe(true);
    expect(search.exactSearch("Part D", { mediCalOnly: true }).some((h) => h.policyId === "MA.6113")).toBe(false);
  });
  it("returns a readable snippet", () => {
    const hit = search.exactSearch("0657").find((h) => h.policyId === "GG.1503")!;
    expect(hit.snippet).toContain("0657");
    expect(hit.snippet).not.toContain("<<page");
  });
});

describe("keywordSearch", () => {
  it("ranks the hospice policy first for a hospice notification question", () => {
    const top = search.topPolicies("hospice Provider must submit the election form notification within calendar days of hospice election", 3);
    expect(top[0].policyId).toBe("GG.1503");
  });
  it("never returns a non-Medi-Cal policy", () => {
    const hits = search.keywordSearch("hospice Part D prescription drugs", 40);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.policyId === "MA.6113")).toBe(false);
  });
  it("can be limited to one policy", () => {
    const hits = search.keywordSearch("housing transition navigation services", 5, { policyId: "GG.1355" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.policyId === "GG.1355")).toBe(true);
  });
});
