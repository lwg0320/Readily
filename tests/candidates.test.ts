import { beforeAll, describe, expect, it } from "vitest";
import { buildChunks, collectCandidates, excerptPolicy, foundByLog, usableTerm, type ScreeningHit } from "../src/pipeline/candidates";
import { createSearch, type Search } from "../src/lib/search";
import type { Policy } from "../src/types";
import { item, loadPolicy, loadSearchIndex } from "./helpers";

const IDS = ["GG.1503", "GG.1550", "GG.1422", "GG.1355", "AA.1000", "MA.6113"];
const CFG = { maxPolicyTokensPerCall: 60_000, longPolicyTokens: 25_000, keywordHitsPerItem: 2, commonTermPolicies: 15, rareTermPolicies: 5 };
let policies: Map<string, Policy>;
let search: Search;
beforeAll(() => {
  policies = new Map(IDS.map((id) => [id, loadPolicy(id)]));
  search = createSearch([...policies.values()], loadSearchIndex());
});

const q53 = item({ id: "Q53-01", parentId: "53", requirement: "Hospice Providers must use Revenue Code 0657 when billing for physician services.", searchTerms: ["Revenue Code 0657", "0657"] });
const q15 = item({ id: "Q15-01", parentId: "15", requirement: "Terminally ill means a life expectancy of six months or less.", searchTerms: [] });

describe("usableTerm", () => {
  it("keeps normal terms and extends very short ones with the next word", () => {
    expect(usableTerm("election form", "x")).toBe("election form");
    expect(usableTerm("900", "designated as hospice with a “900” restricted services code")).toBe("900” restricted");
    expect(usableTerm("900", "nothing here")).toBeNull();
  });
});

describe("collectCandidates (Step 10)", () => {
  it("unions the reader's hits, exact search hits and keyword hits", () => {
    const hits: ScreeningHit[] = [
      { policyId: "GG.1503", itemId: "Q15-01", address: "Glossary: Terminally Ill", strength: "direct" },
      { policyId: "AA.1000", itemId: "Q15-01", address: "Glossary: Terminally Ill", strength: "maybe" },
    ];
    const c = collectCandidates([q53, q15], hits, policies, search, CFG);
    expect(c.get("Q53-01")!.get("GG.1503")!.foundBy.has("exact")).toBe(true);
    expect(c.get("Q15-01")!.get("GG.1503")!.foundBy.has("haiku-direct")).toBe(true);
    expect(c.get("Q15-01")!.get("AA.1000")!.foundBy.has("haiku-maybe")).toBe(true);
    const log = foundByLog(c);
    expect(log.some((l) => l.itemId === "Q53-01" && l.policyId === "GG.1503" && l.foundBy.includes("exact"))).toBe(true);
  });
  it("ignores hits on policies that do not apply to Medi-Cal", () => {
    const c = collectCandidates([q15], [{ policyId: "MA.6113", itemId: "Q15-01", address: "II.A", strength: "direct" }], policies, search, CFG);
    expect(c.get("Q15-01")?.has("MA.6113") ?? false).toBe(false);
  });
  it("treats a rare exact term as a must-read and a widespread one as a hint", () => {
    const rare = collectCandidates([q53], [], policies, search, { ...CFG, keywordHitsPerItem: 0 });
    expect(rare.get("Q53-01")!.get("GG.1503")!.strong).toBe(true);
    const widespread = collectCandidates([q53], [], policies, search, { ...CFG, keywordHitsPerItem: 0, rareTermPolicies: 0 });
    expect(widespread.get("Q53-01")!.get("GG.1503")!.foundBy.has("exact")).toBe(true);
    expect(widespread.get("Q53-01")!.get("GG.1503")!.strong).toBe(false);
  });
  it("makes a 'direct' hit a must-read, but not a 'maybe' or a keyword hit", () => {
    const hits: ScreeningHit[] = [
      { policyId: "GG.1503", itemId: "Q15-01", address: "II.C.2", strength: "direct" },
      { policyId: "GG.1550", itemId: "Q15-01", address: "II.A", strength: "maybe" },
    ];
    const c = collectCandidates([q15], hits, policies, search, CFG);
    expect(c.get("Q15-01")!.get("GG.1503")!.strong).toBe(true);
    expect([...c.get("Q15-01")!.values()].filter((x) => x.strong)).toHaveLength(1);
  });
  it("ignores a search term that is too common to point anywhere", () => {
    const common = item({ id: "Q1-01", parentId: "1", requirement: "zzz", searchTerms: ["Member"] });
    const c = collectCandidates([common], [], policies, search, { ...CFG, commonTermPolicies: 2, keywordHitsPerItem: 0 });
    expect(c.get("Q1-01")).toBeUndefined();
  });
});

describe("buildChunks (Step 10)", () => {
  it("sends short policies whole and long ones as excerpts, within the size cap", () => {
    const hits: ScreeningHit[] = [
      { policyId: "GG.1503", itemId: "Q15-01", address: "Glossary: Terminally Ill", strength: "direct" },
      { policyId: "AA.1000", itemId: "Q15-01", address: "Glossary: Terminally Ill", strength: "direct" },
    ];
    const c = collectCandidates([q15], hits, policies, search, { ...CFG, keywordHitsPerItem: 0 });
    const { chunks, skipped } = buildChunks([q15], c, policies, search, CFG);
    expect(skipped).toHaveLength(0);
    const all = chunks.flatMap((ch) => ch.policies);
    const gg = all.find((p) => p.policyId === "GG.1503")!;
    const aa = all.find((p) => p.policyId === "AA.1000")!;
    expect(gg.mode).toBe("full");
    expect(gg.text).toBe(policies.get("GG.1503")!.canonicalText);
    expect(aa.mode).toBe("excerpt");
    expect(aa.text).toContain("Terminally Ill: A medical prognosis certified by a physician");
    expect(aa.tokens).toBeLessThan(2000);
    for (const ch of chunks) expect(ch.tokens).toBeLessThanOrEqual(CFG.maxPolicyTokensPerCall);
    expect(chunks[0].itemIds).toEqual(["Q15-01"]);
  });

  it("always reads required policies and skips optional ones when the calls are full", () => {
    const a = item({ id: "Q1-01", parentId: "1", requirement: "a" });
    const hits: ScreeningHit[] = [
      { policyId: "GG.1503", itemId: "Q1-01", address: "II.A", strength: "direct" },
      { policyId: "GG.1550", itemId: "Q1-01", address: "II.A", strength: "direct" },
      { policyId: "GG.1355", itemId: "Q1-01", address: "II.A", strength: "maybe" },
      { policyId: "GG.1422", itemId: "Q1-01", address: "II.A", strength: "maybe" },
    ];
    const tight = { ...CFG, maxPolicyTokensPerCall: 18_000, longPolicyTokens: 40_000, keywordHitsPerItem: 0 };
    const c = collectCandidates([a], hits, policies, search, tight);
    const { chunks, skipped } = buildChunks([a], c, policies, search, tight);
    const read = chunks.flatMap((ch) => ch.policies.map((p) => p.policyId));
    expect(read).toContain("GG.1503");
    expect(read).toContain("GG.1550");
    expect(read).toContain("GG.1422"); // small enough to fit beside a required policy
    expect(skipped.map((s) => s.policyId)).toEqual(["GG.1355"]); // optional and too big for the room left
  });

  it("with no must-reads, the best weaker candidates share a single call", () => {
    const a = item({ id: "Q1-01", parentId: "1", requirement: "a" });
    const hits: ScreeningHit[] = ["GG.1503", "GG.1550", "GG.1355", "GG.1422"].map((policyId) => ({ policyId, itemId: "Q1-01", address: "II.A", strength: "maybe" as const }));
    const tight = { ...CFG, maxPolicyTokensPerCall: 18_000, longPolicyTokens: 40_000, keywordHitsPerItem: 0 };
    const c = collectCandidates([a], hits, policies, search, tight);
    const { chunks, skipped } = buildChunks([a], c, policies, search, tight);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].policies.length + skipped.length).toBe(4);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("never opens another call for a weaker candidate", () => {
    const a = item({ id: "Q1-01", parentId: "1", requirement: "a" });
    const hits: ScreeningHit[] = [
      { policyId: "GG.1503", itemId: "Q1-01", address: "II.A", strength: "direct" },
      { policyId: "GG.1550", itemId: "Q1-01", address: "II.A", strength: "maybe" },
      { policyId: "GG.1355", itemId: "Q1-01", address: "II.A", strength: "maybe" },
    ];
    const tight = { ...CFG, maxPolicyTokensPerCall: 15_500, longPolicyTokens: 40_000, keywordHitsPerItem: 0 };
    const c = collectCandidates([a], hits, policies, search, tight);
    const { chunks, skipped } = buildChunks([a], c, policies, search, tight);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].policies.map((p) => p.policyId)).toEqual(["GG.1503"]);
    expect(skipped.map((s) => s.policyId).sort()).toEqual(["GG.1355", "GG.1550"]);
  });

  it("returns no chunks for items nothing pointed to", () => {
    const lonely = item({ id: "Q9-01", parentId: "9", requirement: "zzz" });
    const { chunks } = buildChunks([lonely], new Map(), policies, search, CFG);
    expect(chunks).toHaveLength(0);
  });
});

describe("excerptPolicy", () => {
  it("copies whole lettered sections unchanged, with page markers", () => {
    const p = policies.get("GG.1355")!;
    const text = excerptPolicy(p, ["III.E.1", "Section II.I"], [], search, 40_000);
    expect(text.startsWith("[[GG.1355 |")).toBe(true);
    expect(text).toContain("E. Authorization of CalOptima Health Community Supports is required prior to the initiation of");
    expect(text).toContain("Housing Transition Navigation Services;");
    expect(text).not.toContain("H. Billing for Community Supports");
    expect(text).toMatch(/<<page \d+>>/);
  });
  it("falls back to keyword search inside the policy when no address resolves", () => {
    const p = policies.get("AA.1000")!;
    const text = excerptPolicy(p, ["somewhere"], ["retrospective review medical necessity after treatment"], search, 40_000);
    expect(text).toContain("Retrospective Review:");
  });
});
