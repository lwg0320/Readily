// Scoring a saved run against hand labels (ARCHITECTURE.md §12). Plain functions, no API.
import type { FoundByEntry } from "../pipeline/candidates";
import type { FoundBy, ParentResult, Verdict } from "../types";

export type Label = { question: number; expectedVerdict: Verdict; expectedPolicies: string[]; notes: string };

/** What the naive one-prompt comparison said about one question. */
export type BaselineAnswer = { question: number; answer: "yes" | "no"; citation: string; quote: string; quoteFound: boolean };

export type ScoredRow = {
  label: Label;
  result: ParentResult | null;
  /** Same verdict as the label. */
  verdictRight: boolean | null;
  /** Same Yes/No as the label: "covered" means Yes, anything else means No. */
  answerRight: boolean | null;
  /** Every expected policy is cited in the answer. Null when the label names none or there is no result. */
  cited: boolean | null;
  /** For each expected policy, the search layers that pointed to it. Null when the run did not record them. */
  foundBy: { policyId: string; layers: FoundBy[] }[] | null;
  baseline: BaselineAnswer | null;
  baselineRight: boolean | null;
};

export type Tally = { right: number; of: number };
export type Score = {
  rows: ScoredRow[];
  pipeline: { answer: Tally; verdict: Tally; wrongYes: number; cited: Tally; candidate: Tally | null; layers: Record<FoundBy, number> | null; quotesExact: Tally };
  baseline: { answer: Tally; wrongYes: number; cited: Tally; quotesFound: Tally } | null;
};

const isYes = (v: Verdict) => v === "covered";

export function score(labels: Label[], results: ParentResult[], foundBy: FoundByEntry[] | undefined, baseline: BaselineAnswer[]): Score {
  const byQuestion = new Map(results.map((r) => [r.parentId, r]));
  const baseOf = new Map(baseline.map((b) => [b.question, b]));
  const pointers = new Map<string, Map<string, Set<FoundBy>>>(); // question → policy → layers
  for (const f of foundBy ?? []) {
    const q = f.itemId.match(/^Q(\d+)-/)?.[1];
    if (!q) continue;
    const perPolicy = pointers.get(q) ?? new Map<string, Set<FoundBy>>();
    pointers.set(q, perPolicy);
    const layers = perPolicy.get(f.policyId) ?? new Set<FoundBy>();
    perPolicy.set(f.policyId, layers);
    f.foundBy.forEach((l) => layers.add(l));
  }

  const rows: ScoredRow[] = [...labels]
    .sort((a, b) => a.question - b.question)
    .map((label) => {
      const result = byQuestion.get(String(label.question)) ?? null;
      const citedPolicies = new Set(result?.items.filter((i) => i.status !== "not_covered").flatMap((i) => i.evidence.map((e) => e.policyId)));
      const b = baseOf.get(label.question) ?? null;
      return {
        label,
        result,
        verdictRight: result ? result.verdict === label.expectedVerdict : null,
        answerRight: result ? isYes(result.verdict) === isYes(label.expectedVerdict) : null,
        cited: result && label.expectedPolicies.length ? label.expectedPolicies.every((p) => citedPolicies.has(p)) : null,
        foundBy: foundBy ? label.expectedPolicies.map((policyId) => ({ policyId, layers: [...(pointers.get(String(label.question))?.get(policyId) ?? [])] })) : null,
        baseline: b,
        baselineRight: b ? (b.answer === "yes") === isYes(label.expectedVerdict) : null,
      };
    });

  const tally = (values: (boolean | null)[]): Tally => ({ right: values.filter((v) => v === true).length, of: values.filter((v) => v !== null).length });
  const answered = rows.filter((r) => r.result);
  const withPolicies = answered.filter((r) => r.label.expectedPolicies.length);
  const layers = foundBy ? ({ "haiku-direct": 0, "haiku-maybe": 0, exact: 0, keyword: 0 } as Record<FoundBy, number>) : null;
  if (layers) for (const r of withPolicies) for (const p of r.foundBy ?? []) for (const l of p.layers) layers[l]++;
  const quotes = results.flatMap((r) => r.items.filter((i) => i.status !== "not_covered").flatMap((i) => i.evidence));
  const based = rows.filter((r) => r.baseline);

  return {
    rows,
    pipeline: {
      answer: tally(rows.map((r) => r.answerRight)),
      verdict: tally(rows.map((r) => r.verdictRight)),
      wrongYes: answered.filter((r) => isYes(r.result!.verdict) && !isYes(r.label.expectedVerdict)).length,
      cited: tally(rows.map((r) => r.cited)),
      candidate: foundBy ? tally(withPolicies.map((r) => r.foundBy!.every((p) => p.layers.length > 0))) : null,
      layers,
      quotesExact: { right: quotes.filter((e) => e.status === "exact").length, of: quotes.length },
    },
    baseline: based.length
      ? {
          answer: tally(rows.map((r) => r.baselineRight)),
          wrongYes: based.filter((r) => r.baseline!.answer === "yes" && !isYes(r.label.expectedVerdict)).length,
          cited: tally(based.map((r) => (r.label.expectedPolicies.length ? r.label.expectedPolicies.every((p) => r.baseline!.citation.includes(p)) : null))),
          quotesFound: tally(based.map((r) => (r.baseline!.quote ? r.baseline!.quoteFound : null))),
        }
      : null,
  };
}
