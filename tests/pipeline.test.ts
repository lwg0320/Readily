// End-to-end test of Steps 7–15 with the real client and a simulated API.
// The simulated model answers from the request text, so the prompts' wiring is exercised too.
import { beforeAll, describe, expect, it } from "vitest";
import { createLLM, memoryStore, UsageTracker } from "../src/llm/client";
import { createLibrary, type Library } from "../src/pipeline/library";
import { mergeOutcomes } from "../src/pipeline/runEvidence";
import { runQuestionnaire, type QuestionnaireRun } from "../src/pipeline/runQuestionnaire";
import type { ParentResult, Question } from "../src/types";
import { buildSearchDocs, buildSearchIndex } from "../scripts/prep/searchIndex";
import { loadApl, loadPolicy, loadQuestionnaire } from "./helpers";

const json = (o: unknown) => new Response(JSON.stringify({ content: [{ type: "text", text: `<json>${JSON.stringify(o)}</json>` }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }), { status: 200 });
const fail = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "simulated failure" } }), { status: 400 });

const Q_C2 = "A hospice physician (and attending physician, if any) certifies the Member’s illness is terminal (life expectancy is six (6) months or less if the disease is to run its normal course)";
const Q_C4 = "signs a statement choosing Hospice Care instead of other Medi-Cal covered treatments for the Terminal Illness and related conditions";
const Q_B4 = "signs a statement choosing Hospice Care instead of other Medicare-covered treatments for the Terminal Illness and related conditions";
const Q_F1 = "A Hospice Provider shall submit Notification of Hospice election immediately and no later than thirty (30) calendar days after start of services";

type Log = { task: string; detail: string; body: any }[];

function simulatedApi(log: Log, state: { failedOnce: boolean; checklistTries: number }) {
  return async (_url: any, init: any): Promise<Response> => {
    const body = JSON.parse(init.body);
    const system: string = body.system.map((b: any) => b.text).join("\n");
    const user: string = body.messages[0].content.map((b: any) => b.text).join("\n");

    if (system.includes("You prepare a checklist")) {
      const n = Number(user.match(/QUESTION (\d+):/)![1]);
      log.push({ task: "checklist", detail: String(n), body });
      if (n === 10)
        return json({ items: [
          { requirement: "A physician certifies that the Member has a terminal illness with a life expectancy of six months or less.", quantities: ["6 months"], searchTerms: [], allowsReference: false, fromList: false },
          { requirement: "The Member elects hospice services in lieu of curative care for the terminal illness.", quantities: [], searchTerms: [], allowsReference: false, fromList: false },
        ], listCount: null });
      if (n === 11)
        return json({ items: [{ requirement: "The hospice Provider must submit the election form to the MCP within five calendar days of certification and election.", quantities: ["5 calendar days"], searchTerms: ["election form"], allowsReference: false, fromList: false }], listCount: null });
      // Q25: the first attempt returns too few list entries
      state.checklistTries++;
      const list = [
        { requirement: "The MCP must ensure provision of nursing services by the hospice Provider.", quantities: [], searchTerms: [], allowsReference: false, fromList: true },
        { requirement: "The MCP must ensure provision of physician services by the hospice Provider.", quantities: [], searchTerms: [], allowsReference: false, fromList: true },
      ];
      const network = { requirement: "The MCP may require the Member to use an in-Network hospice Provider unless Medically Necessary services are not available in-Network.", quantities: [], searchTerms: ["in-Network"], allowsReference: false, fromList: false };
      return json({ items: user.includes("NOTE: the question names") ? [...list, network] : [list[0], network], listCount: 2 });
    }

    if (system.includes("You are screening ONE policy")) {
      const policyId = user.match(/\[\[([A-Z]+\.\d+[a-z]?) \|/)![1];
      log.push({ task: "screening", detail: policyId, body });
      if (policyId === "GG.1422" && !state.failedOnce) {
        state.failedOnce = true;
        return fail();
      }
      if (policyId !== "GG.1503") return json({ hits: [] });
      const ids = [...system.matchAll(/^(Q\d+-\d+):/gm)].map((m) => m[1]);
      return json({ hits: ids.filter((id) => id !== "Q25-03").map((id) => ({ itemId: id, address: id.startsWith("Q25") ? "Glossary: Hospice Care" : id === "Q11-01" ? "III.F.1" : "II.C.2", strength: "direct" })).concat([{ itemId: "Q99-01", address: "I", strength: "direct" }]) });
    }

    const n = Number(user.match(/QUESTION (\d+):/)![1]);
    if (user.includes("TASK: FULL READING")) {
      log.push({ task: "reading", detail: String(n), body });
      const ids = [...user.split("TASK: FULL READING")[1].matchAll(/^(Q\d+-\d+):/gm)].map((m) => m[1]);
      const answers: Record<string, object> = {
        "Q10-01": { status: "covered", wording: "equivalent", evidence: [{ policyId: "GG.1503", quote: Q_C2 }], reason: 'policy says "hospice physician", requirement says "physician"' },
        "Q10-02": { status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: Q_B4 }, { policyId: "GG.1503", quote: Q_C4 }], reason: "election statement" },
        "Q11-01": { status: "conflict", wording: "same", evidence: [{ policyId: "GG.1503", quote: Q_F1 }], reason: "thirty days, not five" },
        "Q25-01": { status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: "1. Nursing services;" }], reason: "listed" },
        "Q25-02": { status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: "7. Physician services;" }], reason: "listed" },
        "Q25-03": { status: "covered", wording: "same", evidence: [{ policyId: "GG.1503", quote: "CalOptima Health may require the Member to use an in-Network hospice Provider." }], reason: "made up" },
      };
      return json({ items: ids.map((id) => ({ itemId: id, ...(user.includes("POLICY GG.1503") ? answers[id] : { status: "not_covered", wording: "same", evidence: [], reason: "nothing" }) })) });
    }
    if (user.includes("TASK: TIE-BREAK")) {
      log.push({ task: "tie-break", detail: String(n), body });
      // the third reading confirms what both analysts said
      const items = [...user.split("TASK: TIE-BREAK")[1].matchAll(/^(Q\d+-\d+):.*\n\s+Analyst A says: (\w+)\./gm)].map((m) => ({ itemId: m[1], status: m[2], reason: "confirmed" }));
      return json({ items });
    }
    if (user.includes("TASK: SECOND OPINION")) {
      log.push({ task: "review", detail: String(n), body });
      const task = user.split("TASK: SECOND OPINION")[1];
      const items = [...task.matchAll(/^(Q\d+-\d+):.*\n\s+Proposed: (\w+)/gm)].map((m) => ({ itemId: m[1], agrees: true, proposedStatus: m[2] === "needs_review" ? "not_covered" : m[2], reason: "checked", newEvidence: [] }));
      return json({ items });
    }
    throw new Error("unexpected request");
  };
}

let library: Library;
let questions: Question[];
let run: QuestionnaireRun;
const log: Log = [];
const state = { failedOnce: false, checklistTries: 0 };
const groupsSeen: ParentResult[][] = [];
const tracker = new UsageTracker();
const stages = new Set<string>();

beforeAll(async () => {
  // a search index over just these policies, so keyword hits stay inside the test library
  const policies = ["GG.1503", "GG.1550", "GG.1422", "MA.6113"].map(loadPolicy);
  library = createLibrary(policies, buildSearchIndex(buildSearchDocs(policies as any)));
  const q = loadQuestionnaire();
  questions = [10, 11, 25].map((n) => q.questions[n - 1]);
  const llm = createLLM({ apiKey: () => "sk-ant-test", store: memoryStore(), fetchFn: simulatedApi(log, state) as any, sleep: async () => {} });
  run = await runQuestionnaire({
    questions,
    apl: loadApl(),
    library,
    llm,
    models: { fullReading: "haiku", secondOpinion: "haiku" },
    tracker,
    onProgress: (e) => stages.add(e.stage),
    onGroupDone: (r) => groupsSeen.push(r),
  });
});

const result = (n: number) => run.results.find((r) => r.parentId === String(n))!;

describe("questionnaire pipeline, Steps 7–15", () => {
  it("only ever reads Medi-Cal policies", () => {
    expect(library.mediCal.map((p) => p.id)).toEqual(["GG.1422", "GG.1503", "GG.1550"]);
    expect(log.filter((l) => l.task === "screening").every((l) => l.detail !== "MA.6113")).toBe(true);
  });

  it("builds checklists, retrying when a named list comes back short", () => {
    expect(run.checklists.map((c) => c.items.length)).toEqual([2, 1, 3]);
    expect(state.checklistTries).toBe(2);
    expect(run.checklists[2].flags).toHaveLength(0);
    expect(run.checklists[1].items[0].quantities).toEqual([{ value: 5, unit: "calendar day", unitBase: "day" }]);
    expect(run.checklists[0].items[0].id).toBe("Q10-01");
  });

  it("groups questions by APL page and reports each group as it finishes", () => {
    expect(run.groups).toEqual([[10, 11], [25]]);
    expect(groupsSeen.map((g) => g.map((r) => r.parentId).sort())).toContainEqual(["10", "11"]);
    expect(groupsSeen.map((g) => g.map((r) => r.parentId))).toContainEqual(["25"]);
    expect([...stages]).toEqual(expect.arrayContaining(["checklist", "screening", "reading", "done"]));
  });

  it("reads every policy once per bundle, with the checklist cached in front", () => {
    const screening = log.filter((l) => l.task === "screening");
    expect(run.stats.bundles).toBe(1);
    expect(new Set(screening.map((l) => l.detail))).toEqual(new Set(["GG.1422", "GG.1503", "GG.1550"]));
    expect(screening[0].body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(screening[0].body.output_config).toEqual({ effort: "low" });
    expect(screening[0].body.messages[0].content[0].cache_control).toBeUndefined();
  });

  it("gives the full reading and the second opinion the same cached documents", () => {
    const reading = log.find((l) => l.task === "reading" && l.detail === "10")!;
    const review = log.find((l) => l.task === "review" && l.detail === "10")!;
    const docs = (l: any) => l.body.messages[0].content[0];
    expect(docs(reading).cache_control).toEqual({ type: "ephemeral" });
    expect(docs(review)).toEqual(docs(reading));
    expect(review.body.system).toEqual(reading.body.system);
    expect(docs(reading).text).toContain("===== POLICY GG.1503 =====");
    expect(docs(reading).text).toContain("REGULATOR TEXT (APL 25-008)");
    expect(docs(reading).text).toContain("<<APL 25-008 page 2>>");
  });

  it("never shows the second opinion the first reader's reasoning", () => {
    const review = log.find((l) => l.task === "review" && l.detail === "11")!;
    const task = review.body.messages[0].content[1].text;
    expect(task).not.toContain("thirty days, not five");
    expect(task).toContain("Proposed: conflict");
    expect(task).toContain("Requirement: 5 calendar days · Policy: 30 calendar days");
  });

  it("Q10: covered, cites §II.C only, and flags the wording difference", () => {
    const r = result(10);
    expect(r.verdict).toBe("covered");
    expect(r.suggestedAnswer).toBe("yes");
    const addresses = r.items.flatMap((i) => i.evidence.map((e) => e.address));
    expect(addresses).toEqual(["II.C.2", "II.C.4"]);
    const codes = r.items.flatMap((i) => i.flags.map((f) => f.code));
    expect(codes).toContain("wording_differs");
    expect(codes).toContain("wrong_program_removed"); // the §II.B.4 quote was thrown out
    expect(codes).toContain("policy_predates_apl");
    expect(codes).toContain("cites_superseded_apl");
    expect(r.suggestedCitation).toBe("GG.1503 §II.C.2, p.2; GG.1503 §II.C.4, p.2");
    expect(r.items.every((i) => i.reviewer?.agrees)).toBe(true);
  });

  it("Q11: conflict, 5 days against thirty (30), reported only after a third reading confirmed it", () => {
    const r = result(11);
    expect(log.filter((l) => l.task === "tie-break").map((l) => l.detail)).toEqual(["11"]);
    expect(r.items[0].tieBreak).toEqual({ status: "conflict", reason: "confirmed" });
    expect(r.verdict).toBe("conflict");
    expect(r.suggestedAnswer).toBe("no");
    expect(r.items[0].evidence[0]).toMatchObject({ address: "III.F.1", page: 9, policyId: "GG.1503" });
    expect(r.items[0].flags.find((f) => f.code === "number_mismatch")?.detail).toBe("Requirement: 5 calendar days · Policy: 30 calendar days");
  });

  it("Q25: partial — listed services found in the glossary, the made-up in-network quote rejected", () => {
    const r = result(25);
    expect(r.verdict).toBe("partial");
    expect(r.suggestedAnswer).toBeNull();
    expect(r.items.map((i) => i.status)).toEqual(["covered", "covered", "not_covered"]);
    expect(r.items[0].evidence[0].address).toBe("Glossary: Hospice Care");
    expect(r.items[2].evidence).toHaveLength(0);
  });

  it("Step 14: retries the failed read and attaches a search trail before saying not found", () => {
    expect(log.filter((l) => l.task === "screening" && l.detail === "GG.1422")).toHaveLength(2);
    const trail = result(25).items[2].trail!;
    expect(trail.policiesRead).toBe(3);
    expect(trail.exactTerms[0].term).toBe("in-Network");
    expect(trail.closest).not.toBeNull();
    // every policy in the library was read in full for this requirement before giving up
    const readings = log.filter((l) => l.task === "reading" && l.detail === "25");
    const docsRead = readings.map((l) => l.body.messages[0].content[0].text as string).join("\n");
    for (const id of ["GG.1503", "GG.1550", "GG.1422"]) expect(docsRead).toContain(`===== POLICY ${id} =====`);
    // the extra look asks only about what is still open
    expect(readings.length).toBe(2);
    expect(readings[1].body.messages[0].content[1].text).not.toContain("Q25-01:");
    expect(readings[1].body.messages[0].content[1].text).toContain("Q25-03:");
  });

  it("ignores a requirement ID the model invented", () => {
    expect(run.foundBy.some((f) => f.itemId === "Q99-01")).toBe(false);
    expect(run.foundBy.find((f) => f.itemId === "Q11-01" && f.policyId === "GG.1503")?.foundBy).toEqual(expect.arrayContaining(["haiku-direct", "exact"]));
  });

  it("tracks cost per task", () => {
    expect(Object.keys(tracker.byTask).sort()).toEqual(["checklist", "fullReading", "readEveryPolicy", "secondOpinion"]);
    expect(tracker.totalCost).toBeGreaterThan(0);
  });
});

describe("mergeOutcomes", () => {
  const o = (status: any, extra: object = {}) => ({ status, evidence: [], flags: [], readerReason: status, reviewer: null, ...extra });
  const disputed = { flags: [{ code: "reviewer_disputed" as const, detail: "x" }] };
  const failed = { failed: true, flags: [{ code: "analysis_failed" as const, detail: "could not be read" }] };
  it("takes the status, evidence and flags from the winning outcome only", () => {
    const m = mergeOutcomes([o("not_covered", disputed), o("covered")]);
    expect(m.status).toBe("covered");
    expect(m.flags).toHaveLength(0);
  });
  it("a confirmed conflict beats an open question and 'nothing found'", () => {
    expect(mergeOutcomes([o("not_covered"), o("conflict"), o("needs_review")]).status).toBe("conflict");
  });
  it("one set states the requirement and another conflicts with it → a person sees both", () => {
    const quote = (policyId: string) => ({ evidence: [{ policyId, quote: `text in ${policyId}`, page: 1, address: "II.A", kind: "body", scope: "both", status: "exact" } as any] });
    const m = mergeOutcomes([o("covered", quote("GG.1503")), o("conflict", quote("GG.1325")), o("not_covered")]);
    expect(m.status).toBe("needs_review");
    expect(m.evidence.map((e) => e.policyId)).toEqual(["GG.1503", "GG.1325"]);
    expect(m.flags[0]).toEqual({ code: "policies_disagree", detail: "GG.1503 states the requirement, but GG.1325 appears to set a different rule." });
  });
  it("confirmed evidence in one set of policies beats an open question in another", () => {
    // e.g. an unrelated policy produced a 'conflict' that the second opinion threw out
    const m = mergeOutcomes([o("needs_review", disputed), o("covered")]);
    expect(m.status).toBe("covered");
    expect(m.flags).toHaveLength(0);
  });
  it("a set that could not be read never hides evidence found in another set", () => {
    const m = mergeOutcomes([o("needs_review", failed), o("covered")]);
    expect(m.status).toBe("covered");
    expect(m.flags).toHaveLength(0);
    expect(mergeOutcomes([o("needs_review", failed), o("needs_review", disputed)]).flags.map((f) => f.code)).toEqual(["reviewer_disputed"]);
  });
  it("but nothing is called not found while a read is missing", () => {
    const m = mergeOutcomes([o("not_covered"), o("needs_review", failed), o("not_covered")]);
    expect(m.status).toBe("needs_review");
    expect(m.flags.map((f) => f.code)).toEqual(["analysis_failed"]);
  });
  it("is not covered when nothing was read", () => {
    expect(mergeOutcomes([]).status).toBe("not_covered");
  });
});
