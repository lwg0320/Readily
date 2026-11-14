// Steps 11 and 13 on a long checklist: it is read in parts, and a part whose reply cannot be
// read is asked again one requirement at a time. Real client, simulated API.
import { beforeAll, describe, expect, it } from "vitest";
import { createLLM, memoryStore } from "../src/llm/client";
import { createLibrary } from "../src/pipeline/library";
import { runEvidence, type EvidenceRun } from "../src/pipeline/runEvidence";
import { buildSearchDocs, buildSearchIndex } from "../scripts/prep/searchIndex";
import { APL_25_008, item, loadPolicy } from "./helpers";

const reply = (text: string) => new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }), { status: 200 });
const json = (o: unknown) => reply(`<json>${JSON.stringify(o)}</json>`);

const SERVICES = ["1. Nursing services;", "2. Physical or occupational therapy, or speech-language pathology;", "3. Medical social services under the direction of a physician;", "4. Home health aide and homemaker services;", "5. Medical supplies and appliances;", "6. Drugs and biologicals;", "7. Physician services;"];
const items = [
  ...SERVICES.map((s, i) => item({ id: `Q25-0${i + 1}`, parentId: "25", requirement: `The MCP must ensure provision of ${s.slice(3, -1).toLowerCase()} by the hospice Provider.` })),
  item({ id: "Q25-08", parentId: "25", requirement: "The MCP may require the Member to use an in-Network hospice Provider." }),
];
const idsIn = (task: string) => [...task.matchAll(/^(Q\d+-\d+):/gm)].map((m) => m[1]);

const readings: string[][] = [];
const reviews: string[][] = [];
const tieBreaks: string[] = [];
let run: EvidenceRun;

beforeAll(async () => {
  const policies = ["GG.1503", "GG.1550"].map(loadPolicy);
  const library = createLibrary(policies, buildSearchIndex(buildSearchDocs(policies as any)));
  const fetchFn = async (_url: any, init: any): Promise<Response> => {
    const body = JSON.parse(init.body);
    const system: string = body.system.map((b: any) => b.text).join("\n");
    const user: string = body.messages[0].content.map((b: any) => b.text).join("\n");
    if (system.includes("You are screening ONE policy")) {
      return json({ hits: user.includes("[[GG.1503 |") ? items.map((i) => ({ itemId: i.id, address: "Glossary: Hospice Care", strength: "direct" })) : [] });
    }
    if (user.includes("TASK: FULL READING")) {
      const ids = idsIn(user.split("TASK: FULL READING")[1]);
      readings.push(ids);
      // a reply for several requirements that includes Q25-02 is always unreadable
      if (ids.length > 1 && ids.includes("Q25-02")) return reply("I could not finish this.");
      return json({ items: ids.map((id) => {
        const n = Number(id.slice(-2));
        return n <= 7 ? { itemId: id, status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: SERVICES[n - 1] }], reason: "listed" } : { itemId: id, status: "not_covered", wording: "same", evidence: [], reason: "nothing" };
      }) });
    }
    if (user.includes("TASK: TIE-BREAK")) {
      const task = user.split("TASK: TIE-BREAK")[1];
      tieBreaks.push(task);
      // sides with the reader on Q25-05 and with the reviewer on Q25-06
      return json({ items: idsIn(task).map((id) => ({ itemId: id, status: id === "Q25-05" ? "covered" : "not_covered", reason: "settled" })) });
    }
    const ids = idsIn(user.split("TASK: SECOND OPINION")[1]);
    reviews.push(ids);
    return json({ items: ids.map((id) => {
      // the reviewer objects to two answers; one of its replies also carries a malformed quote entry
      if (id === "Q25-05" || id === "Q25-06") return { itemId: id, agrees: false, proposedStatus: "not_covered", reason: "the list entry alone does not prove it", newEvidence: [] };
      return { itemId: id, agrees: true, proposedStatus: id === "Q25-08" ? "not_covered" : "covered", reason: "checked", newEvidence: id === "Q25-07" ? [{ section: "II.A", text: 5 }] : [] };
    }) });
  };
  const llm = createLLM({ apiKey: () => "sk-ant-test", store: memoryStore(), fetchFn: fetchFn as any, sleep: async () => {} });
  run = await runEvidence({
    groups: [{ parents: [{ id: "25", label: "QUESTION 25", text: "Does the P&P state …?", items, flags: [] }], regulatorText: "APL text" }],
    regulator: APL_25_008,
    library,
    llm,
    models: { fullReading: "haiku", secondOpinion: "haiku" },
  });
});

describe("a long checklist (Steps 11 and 13)", () => {
  it("is read in parts of even size, never more than six requirements per call", () => {
    const first = readings.filter((r) => r.length > 1);
    // two parts of four; the unreadable one is asked twice (one try, one request to repair the reply)
    expect(first.map((r) => r.length)).toEqual([4, 4, 4]);
    expect(Math.max(...readings.map((r) => r.length))).toBeLessThanOrEqual(6);
  });
  it("asks again one requirement at a time when a part's reply cannot be read", () => {
    const single = readings.filter((r) => r.length === 1).map((r) => r[0]).sort();
    expect(single).toEqual(["Q25-01", "Q25-02", "Q25-03", "Q25-04"]);
  });
  it("so every requirement still gets an answer and a second opinion", () => {
    const r = run.results[0];
    expect(r.items.map((i) => i.status)).toEqual(["covered", "covered", "covered", "covered", "covered", "not_covered", "covered", "not_covered"]);
    expect(r.items.flatMap((i) => i.flags.map((f) => f.code))).not.toContain("analysis_failed");
    expect(r.verdict).toBe("partial");
    expect(new Set(reviews.flat())).toEqual(new Set(items.map((i) => i.id)));
    expect(r.items[1].evidence[0]).toMatchObject({ policyId: "GG.1503", address: "Glossary: Hospice Care", page: 16 });
  });
  it("settles a disagreement between the two readings with a tie-break that sees both sides", () => {
    expect(tieBreaks).toHaveLength(1); // only the part with disputed requirements, and only those
    expect(idsIn(tieBreaks[0])).toEqual(["Q25-05", "Q25-06"]);
    expect(tieBreaks[0]).toContain("Analyst A says: covered. listed");
    expect(tieBreaks[0]).toContain("Analyst B says: not_covered. the list entry alone does not prove it");
    expect(tieBreaks[0]).toContain('"5. Medical supplies and appliances;"');
    const [upheld, overturned] = [run.results[0].items[4], run.results[0].items[5]];
    expect(upheld).toMatchObject({ status: "covered", tieBreak: { status: "covered" }, reviewer: { agrees: false } });
    expect(upheld.flags.map((f) => f.code)).toContain("reviewer_disputed");
    expect(overturned).toMatchObject({ status: "not_covered", tieBreak: { status: "not_covered" } });
    expect(overturned.evidence).toHaveLength(1); // kept, shown as disputed
  });
  it("drops a malformed quote entry instead of losing the whole reply", () => {
    expect(run.results[0].items[6]).toMatchObject({ status: "covered", reviewer: { agrees: true } });
  });
  it("records which policies were read in full", () => {
    expect(run.documentSets[0].policies.map((p) => p.policyId)).toContain("GG.1503");
    expect(run.documentSets[0].parentIds).toEqual(["25"]);
  });
});
