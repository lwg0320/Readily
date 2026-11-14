// Steps 22 and 24 — the Policy Guide: sentences, obligations, and the section check.
// Real prepared Guide and policies; simulated API.
import { beforeAll, describe, expect, it } from "vitest";
import { createLLM, memoryStore } from "../src/llm/client";
import { findObligations, obligationItems, type SectionObligations } from "../src/pipeline/findObligations";
import { createLibrary } from "../src/pipeline/library";
import { regulatorFromGuide, runSectionCheck } from "../src/pipeline/runSectionCheck";
import { splitSentences } from "../src/pipeline/sentences";
import type { EvidenceRun } from "../src/pipeline/runEvidence";
import { buildSearchDocs, buildSearchIndex } from "../scripts/prep/searchIndex";
import type { Guide } from "../src/types";
import { loadPolicy } from "./helpers";
import guideJson from "../public/data/guides/ecm-2026-01.json";

const guide = guideJson as unknown as Guide;
const section = guide.sections.find((s) => s.id === "s015")!; // "(Updated January 2026) Community Supports", pages 17–18
const reply = (o: unknown) => new Response(JSON.stringify({ content: [{ type: "text", text: `<json>${JSON.stringify(o)}</json>` }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 200 } }), { status: 200 });

describe("splitSentences", () => {
  const sentences = splitSentences(section);
  const find = (start: string) => sentences.find((s) => s.text.startsWith(start))!;
  it("numbers the sentences in reading order and keeps their page", () => {
    expect(sentences.map((s) => s.id).slice(0, 4)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(sentences[0].page).toBe(17);
    expect(find("When the MCP authorizes").page).toBe(18);
  });
  it("carries a sentence across a page break and joins a word broken across lines", () => {
    expect(sentences[0].text).toMatch(/under this Population of Focus\.16$/);
    expect(find("Transition Navigation Services").text).toContain("long-term housing");
  });
  it("splits a bullet into its sentences, footnote numbers included", () => {
    const bullet = sentences.filter((s) => s.block === find("Transitional Rent provides").block);
    expect(bullet).toHaveLength(4);
    expect(bullet.every((s) => s.bullet)).toBe(true);
    expect(bullet[2].text).toMatch(/outreach visits to the Member\.17$/);
  });
  it("marks the sentences that sound like a duty", () => {
    expect(sentences.filter((s) => s.cue).map((s) => s.text.slice(0, 28))).toEqual(["(Updated January 2026) Commu", "When the MCP authorizes a Me", "The MCP is required to ensur"]);
  });
  it("keeps each footnote whole, with its own page", () => {
    const notes = sentences.filter((s) => s.footnote);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ page: 17, text: expect.stringMatching(/^\[Footnote 14, p\.17\] As established in 42 CFR § 438\.208 and 42 CFR § 441\.301\.$/) });
  });
  it("does not break after abbreviations or list numbers", () => {
    const s = splitSentences({ pageStart: 3, text: "1. Plans, e.g. MCPs in the U.S. Virgin Islands, must report quarterly. Providers may ask; DHCS decides." });
    expect(s.map((x) => x.text)).toEqual(["1. Plans, e.g. MCPs in the U.S. Virgin Islands, must report quarterly.", "Providers may ask;", "DHCS decides."]);
  });
  it("handles every section of the Guide", () => {
    for (const s of guide.sections) {
      const all = splitSentences(s);
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((x) => x.page >= s.pageStart && x.page <= s.pageEnd + 1)).toBe(true);
    }
  });
});

describe("findObligations (Step 22)", () => {
  const model = {
    obligations: [
      { summary: "The MCP is strongly encouraged to offer housing-related Community Supports to Members enrolled in ECM under this Population of Focus.", actor: "plan", strength: "recommended", sentenceIds: ["S1"], quantities: [], searchTerms: ["Community Supports"] },
      { summary: "The MCP must authorize the Member for ECM whenever it authorizes the Member for Transitional Rent.", actor: "plan", strength: "binding", sentenceIds: ["S3", "S2"], quantities: ["6 months"], searchTerms: ["Transitional Rent", "Transitional Rent", " "] },
      { summary: "An obligation that points at nothing in the text.", actor: "plan", strength: "binding", sentenceIds: ["S99"], quantities: [], searchTerms: [] },
    ],
    nonObligations: [{ sentenceId: "S2", reason: "already used above" }],
  };
  let result: SectionObligations;
  const asked: string[] = [];
  beforeAll(async () => {
    const fetchFn = async (_u: unknown, init: any) => {
      const user: string = JSON.parse(init.body).messages[0].content.map((b: any) => b.text).join("\n");
      asked.push(user);
      // only when told that S4 was left out does the model account for it
      return reply(user.includes("NOTE: an earlier answer did not account for S4") ? { ...model, obligations: [...model.obligations, { summary: "The MCP must ensure that the ECM Provider conducts weekly in-person outreach visits to a Member authorized for Transitional Rent.", actor: "plan", strength: "binding", sentenceIds: ["S4"], quantities: [], searchTerms: ["weekly in-person outreach"] }] } : model);
    };
    result = await findObligations({ section, llm: createLLM({ apiKey: () => "sk-ant-test", store: memoryStore(), fetchFn: fetchFn as any, sleep: async () => {} }) });
  });

  it("sends the numbered sentences, the heading path and the cue list", () => {
    expect(asked[0]).toContain("SECTION: IV. ECM POPULATIONS OF FOCUS > 1. Individuals and Families Experiencing Homelessness > C. Operational Guidance: > (Updated January 2026) Community Supports");
    expect(asked[0]).toContain("[S3] (page 18) When the MCP authorizes a Member for Transitional Rent, it must also authorize the Member for ECM.");
    expect(asked[0]).toContain("CUE SENTENCES: S1, S3, S4");
  });
  it("asks once more when a cue sentence was not accounted for", () => {
    expect(asked).toHaveLength(2);
    expect(result.unexplained).toEqual([]);
  });
  it("keeps only obligations that can be traced to the text, with exact source text and page", () => {
    expect(result.obligations.map((o) => o.id)).toEqual(["OB-01", "OB-02", "OB-03"]);
    const rent = result.obligations[1];
    expect(rent.sentenceIds).toEqual(["S2", "S3"]);
    expect(rent.page).toBe(18);
    expect(rent.sourceText).toBe("Transitional Rent provides up to six months of rental assistance in interim and permanent settings. When the MCP authorizes a Member for Transitional Rent, it must also authorize the Member for ECM.");
    expect(rent.searchTerms).toEqual(["Transitional Rent"]);
    expect(result.obligations.filter((o) => /Transitional Rent/.test(o.summary))).toHaveLength(2);
  });
  it("does not list a used sentence as a non-obligation", () => {
    expect(result.nonObligations).toEqual([]);
  });
  it("turns obligations into checks, comparing only numbers the summary itself states", () => {
    const items = obligationItems(section.id, result.obligations);
    expect(items[1]).toEqual({ id: "OB-02", parentId: "s015", requirement: result.obligations[1].summary, quantities: [], searchTerms: ["Transitional Rent"], allowsReference: false });
  });
});

describe("runSectionCheck (Step 24)", () => {
  let run: EvidenceRun;
  const seen = { screening: 0, readingUser: "", docs: "" };
  const obligations = [
    { id: "OB-01", summary: "The MCP must authorize the Member for ECM whenever it authorizes the Member for Transitional Rent.", actor: "plan" as const, strength: "binding" as const, sentenceIds: ["S3"], sourceText: "…", page: 18, quantities: [], searchTerms: ["Transitional Rent"] },
    { id: "OB-02", summary: "The MCP must ensure that Hospice Care services are provided to Terminally Ill Members.", actor: "plan" as const, strength: "binding" as const, sentenceIds: ["S1"], sourceText: "…", page: 17, quantities: [], searchTerms: [] },
  ];
  beforeAll(async () => {
    const policies = ["GG.1503", "GG.1550", "GG.1422"].map(loadPolicy);
    const library = createLibrary(policies, buildSearchIndex(buildSearchDocs(policies as any)));
    const ids = (t: string) => [...t.matchAll(/^(OB-\d+):/gm)].map((m) => m[1]);
    const fetchFn = async (_u: unknown, init: any) => {
      const body = JSON.parse(init.body);
      const system: string = body.system.map((b: any) => b.text).join("\n");
      const user: string = body.messages[0].content.map((b: any) => b.text).join("\n");
      if (system.includes("You are screening ONE policy")) {
        seen.screening++;
        return reply({ hits: user.includes("[[GG.1503 |") ? [{ itemId: "OB-02", address: "II.A", strength: "direct" }] : [] });
      }
      if (user.includes("TASK: FULL READING")) {
        seen.docs = user.split("TASK: FULL READING")[0];
        seen.readingUser = user.split("TASK: FULL READING")[1];
        return reply({ items: ids(seen.readingUser).map((itemId) => (itemId === "OB-02" && user.includes("[[GG.1503 |") ? { itemId, status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: "CalOptima Health and its Health Networks shall be responsible for ensuring the provision of Hospice Care services" }], reason: "II.A" } : { itemId, status: "not_covered", wording: "same", evidence: [], reason: "nothing" })) });
      }
      return reply({ items: [...user.split("TASK: SECOND OPINION")[1].matchAll(/^(OB-\d+):.*\n\s+Proposed: (\w+)/gm)].map((m) => ({ itemId: m[1], agrees: true, proposedStatus: m[2], reason: "checked", newEvidence: [] })) });
    };
    run = await runSectionCheck({ guide, section, obligations, library, llm: createLLM({ apiKey: () => "sk-ant-test", store: memoryStore(), fetchFn: fetchFn as any, sleep: async () => {} }), models: { fullReading: "haiku", secondOpinion: "haiku" } });
  });

  it("reads every policy once against the obligations", () => {
    expect(seen.screening).toBe(3);
  });
  it("gives the readers the section as regulator text and the obligations as requirements", () => {
    expect(seen.docs).toContain("ECM Policy Guide");
    expect(seen.docs).toContain("When the MCP authorizes a Member for");
    expect(seen.readingUser).toContain("POLICY GUIDE SECTION:");
    expect(seen.readingUser).toContain("OB-01: The MCP must authorize the Member for ECM whenever it authorizes the Member for Transitional Rent.");
  });
  it("returns one result for the section, with one answer per obligation", () => {
    expect(run.results).toHaveLength(1);
    const [r] = run.results;
    expect(r.parentId).toBe("s015");
    expect(r.items.map((i) => [i.item.id, i.status])).toEqual([["OB-01", "not_covered"], ["OB-02", "covered"]]);
    expect(r.items[1].evidence[0]).toMatchObject({ policyId: "GG.1503", address: "II.A", page: 1 });
  });
  it("backs 'not found' with a search trail: Transitional Rent is in no policy", () => {
    const trail = run.results[0].items[0].trail!;
    expect(trail.exactTerms).toEqual([{ term: "Transitional Rent", hits: 0 }]);
    expect(trail.closest).not.toBeNull();
  });
  it("claims a policy is out of date only for a section marked Updated", () => {
    expect(run.results[0].items[1].flags.map((f) => f.code)).toContain("policy_predates_apl");
    expect(regulatorFromGuide(guide, { updated: false }).date).toBeNull();
    expect(regulatorFromGuide(guide, { updated: true })).toMatchObject({ label: "ECM Policy Guide", date: "2026-01-01", isGuide: true });
  });
});
