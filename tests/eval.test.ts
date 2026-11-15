import { describe, expect, it, vi } from "vitest";
import { runBaseline } from "../src/eval/baseline";
import bundled from "../src/eval/labels.json";
import { score, type BaselineAnswer, type Label } from "../src/eval/score";
import { createLLM, memoryStore, UsageTracker } from "../src/llm/client";
import type { FoundByEntry } from "../src/pipeline/candidates";
import type { Evidence, ItemResult, ParentResult, Verdict } from "../src/types";
import { loadPolicy, loadQuestionnaire } from "./helpers";

const quote = (policyId: string, status: Evidence["status"] = "exact"): Evidence => ({ policyId, quote: "text", page: 1, address: "II.A", kind: "body", scope: "medi-cal", status } as Evidence);
const item = (id: string, status: ItemResult["status"], evidence: Evidence[]): ItemResult => ({ itemId: id, status, evidence } as unknown as ItemResult);
const result = (n: number, verdict: Verdict, items: ItemResult[] = []): ParentResult => ({ parentId: String(n), verdict, suggestedAnswer: null, suggestedCitation: "", approved: false, items });
const label = (question: number, expectedVerdict: Verdict, expectedPolicies: string[] = ["GG.1503"]): Label => ({ question, expectedVerdict, expectedPolicies, notes: "" });

describe("scoring a run against hand labels", () => {
  const labels = [label(11, "conflict"), label(10, "covered"), label(25, "partial"), label(40, "not_found", []), label(50, "covered")];
  const results = [
    result(10, "covered", [item("Q10-01", "covered", [quote("GG.1503"), quote("GG.1503", "corrected")])]),
    result(11, "partial", [item("Q11-01", "covered", [quote("GG.1550")]), item("Q11-02", "not_covered", [quote("GG.1503")])]),
    result(25, "covered", [item("Q25-01", "covered", [quote("GG.1503")])]),
    result(40, "not_found"),
    result(3, "covered", [item("Q3-01", "covered", [quote("AA.1000")])]),
  ];
  const foundBy: FoundByEntry[] = [
    { itemId: "Q10-01", policyId: "GG.1503", foundBy: ["haiku-direct", "exact"], strong: true },
    { itemId: "Q10-02", policyId: "GG.1503", foundBy: ["keyword"], strong: false },
    { itemId: "Q11-01", policyId: "GG.1550", foundBy: ["haiku-maybe"], strong: false },
    { itemId: "OB-01", policyId: "GG.1503", foundBy: ["exact"], strong: true },
  ];
  const s = score(labels, results, foundBy, []);
  const row = (n: number) => s.rows.find((r) => r.label.question === n)!;

  it("lists the labelled questions in order and leaves unanswered ones unscored", () => {
    expect(s.rows.map((r) => r.label.question)).toEqual([10, 11, 25, 40, 50]);
    expect(row(50)).toMatchObject({ result: null, verdictRight: null, answerRight: null, cited: null });
  });
  it("counts exact verdicts, and Yes or No with only “covered” as Yes", () => {
    expect(s.pipeline.verdict).toEqual({ right: 2, of: 4 });
    expect(s.pipeline.answer).toEqual({ right: 3, of: 4 }); // Q11 partial vs conflict: both No
    expect(row(11)).toMatchObject({ verdictRight: false, answerRight: true });
  });
  it("counts a Yes the label disagrees with as the dangerous mistake", () => {
    expect(s.pipeline.wrongYes).toBe(1); // Q25
  });
  it("checks the expected policy is cited by a part that was not rejected", () => {
    expect(row(10).cited).toBe(true);
    expect(row(11).cited).toBe(false); // GG.1503 appears only under a part marked not covered
    expect(row(40).cited).toBeNull(); // the label names no policy
    expect(s.pipeline.cited).toEqual({ right: 2, of: 3 });
  });
  it("reports which search layers pointed to each expected policy", () => {
    expect(row(10).foundBy).toEqual([{ policyId: "GG.1503", layers: ["haiku-direct", "exact", "keyword"] }]);
    expect(row(11).foundBy).toEqual([{ policyId: "GG.1503", layers: [] }]);
    expect(s.pipeline.candidate).toEqual({ right: 1, of: 3 });
    expect(s.pipeline.layers).toEqual({ "haiku-direct": 1, "haiku-maybe": 0, exact: 1, keyword: 1 });
  });
  it("says the search record is missing for runs saved without one", () => {
    const old = score(labels, results, undefined, []);
    expect(old.pipeline.candidate).toBeNull();
    expect(old.pipeline.layers).toBeNull();
    expect(old.rows[0].foundBy).toBeNull();
  });
  it("counts word-for-word quotes over the whole run, leaving out rejected parts", () => {
    expect(s.pipeline.quotesExact).toEqual({ right: 4, of: 5 });
  });
  it("scores the naive baseline the same way", () => {
    const baseline: BaselineAnswer[] = [
      { question: 10, answer: "yes", citation: "GG.1503 §II.C", quote: "q", quoteFound: true },
      { question: 11, answer: "yes", citation: "GG.1550 §III", quote: "q", quoteFound: false },
      { question: 40, answer: "no", citation: "", quote: "", quoteFound: false },
    ];
    const b = score(labels, results, foundBy, baseline).baseline!;
    expect(b.answer).toEqual({ right: 2, of: 3 });
    expect(b.wrongYes).toBe(1);
    expect(b.cited).toEqual({ right: 1, of: 2 });
    expect(b.quotesFound).toEqual({ right: 1, of: 2 });
    expect(s.baseline).toBeNull();
  });
});

describe("the labels file", () => {
  it("names real questions, known verdicts and real policies", () => {
    const numbers = new Set(loadQuestionnaire().questions.map((q) => q.number));
    const verdicts = ["covered", "partial", "conflict", "not_found", "needs_review"];
    expect(bundled.length).toBeGreaterThan(0);
    expect(new Set(bundled.map((l) => l.question)).size).toBe(bundled.length);
    for (const l of bundled) {
      expect(numbers.has(l.question)).toBe(true);
      expect(verdicts).toContain(l.expectedVerdict);
      for (const p of l.expectedPolicies) expect(loadPolicy(p).id).toBe(p);
    }
  });
});

describe("the naive baseline", () => {
  const real = "CalOptima Health and its Health Networks shall be responsible for ensuring the provision of Hospice Care services";
  const answers: Record<number, object> = {
    10: { answer: "Yes", citation: "GG.1503 §II.A, page 1", quote: real },
    11: { answer: "yes", citation: "GG.1503 §III.F", quote: "The provider shall notify within five (5) calendar days of election." },
    12: { answer: "no", citation: null, quote: null },
  };
  it("asks one question per call with both policies, and checks each quote against them", async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const user = body.messages[0].content.map((b: any) => b.text).join("\n");
      const n = Number(user.match(/QUESTION (\d+):/)![1]);
      if (n === 19) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "simulated" } }), { status: 400 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: `<json>${JSON.stringify(answers[n])}</json>` }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 60 } }), { status: 200 });
    });
    const llm = createLLM({ apiKey: () => "sk-ant-test", store: memoryStore(), fetchFn: fetchFn as any, sleep: async () => {}, browser: true, onThrottle: () => {} });
    const tracker = new UsageTracker();
    const questions = loadQuestionnaire().questions.filter((q) => [10, 11, 12, 19].includes(q.number));
    const out = await runBaseline({ questions, policies: [loadPolicy("GG.1503"), loadPolicy("GG.1550")], model: "haiku", llm, tracker });

    expect(bodies).toHaveLength(4);
    const first = bodies[0].messages[0].content;
    expect(first[0].text).toContain("GG.1503");
    expect(first[0].text).toContain("GG.1550");
    expect(first[0].cache_control).toBeTruthy();
    expect(first.at(-1).text).toContain("Does the P&P state this? Answer yes or no with a citation.");
    expect(out).toEqual([
      { question: 10, answer: "yes", citation: "GG.1503 §II.A, page 1", quote: real, quoteFound: true },
      { question: 11, answer: "yes", citation: "GG.1503 §III.F", quote: "The provider shall notify within five (5) calendar days of election.", quoteFound: false },
      { question: 12, answer: "no", citation: "", quote: "", quoteFound: false },
    ]);
    expect(tracker.totalCost).toBeGreaterThan(0);
  });
});
