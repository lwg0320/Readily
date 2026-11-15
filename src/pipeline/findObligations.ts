// Step 22 — the obligations in one Guide section (ARCHITECTURE.md §8).
import { TASKS } from "../config/models";
import type { LLM, UsageTracker } from "../llm/client";
import { OBLIGATIONS_SYSTEM, obligationsSchema, obligationsUser, type ObligationsOutput } from "../llm/prompts/obligations";
import { extractQuantities } from "../lib/text";
import type { GuideSection, Item } from "../types";
import { splitSentences, type Sentence } from "./sentences";

export type Obligation = {
  /** "OB-01", "OB-02", … Also the ID of the check made from it. */
  id: string;
  summary: string;
  actor: "plan" | "provider" | "other";
  strength: "binding" | "recommended";
  sentenceIds: string[];
  /** The source sentences, word for word, and the page of the first one. */
  sourceText: string;
  page: number;
  quantities: string[];
  searchTerms: string[];
};

export type SectionObligations = {
  obligations: Obligation[];
  /** Cue sentences the model decided are not obligations, with its reason. */
  nonObligations: { sentenceId: string; reason: string }[];
  /** Cue sentences nobody accounted for, even after asking again: a person should read them. */
  unexplained: string[];
};

function accountFor(out: ObligationsOutput, sentences: Sentence[]): SectionObligations {
  const known = new Map(sentences.map((s) => [s.id, s]));
  const obligations: Obligation[] = [];
  for (const o of out.obligations) {
    const ids = [...new Set(o.sentenceIds)].filter((id) => known.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (!ids.length) continue; // an obligation that cannot be traced to the text is not kept
    obligations.push({
      id: `OB-${String(obligations.length + 1).padStart(2, "0")}`,
      summary: o.summary.trim(),
      actor: o.actor,
      strength: o.strength,
      sentenceIds: ids,
      sourceText: ids.map((id) => known.get(id)!.text).join(" "),
      page: known.get(ids[0])!.page,
      quantities: o.quantities,
      // a single common word ("ECM") points everywhere; phrases and codes are kept
      searchTerms: [...new Set(o.searchTerms.map((t) => t.trim()).filter((t) => /\s/.test(t) || /\d/.test(t)))].slice(0, 4),
    });
  }
  const used = new Set(obligations.flatMap((o) => o.sentenceIds));
  const nonObligations = out.nonObligations.filter((n) => known.has(n.sentenceId) && !used.has(n.sentenceId));
  const explained = new Set([...used, ...nonObligations.map((n) => n.sentenceId)]);
  return { obligations, nonObligations, unexplained: sentences.filter((s) => s.cue && !explained.has(s.id)).map((s) => s.id) };
}

export async function findObligations(args: { section: GuideSection; llm: LLM; tracker?: UsageTracker; signal?: AbortSignal }): Promise<SectionObligations> {
  const { section, llm, tracker, signal } = args;
  const sentences = splitSentences(section);
  const ask = async (missing: string[]) => {
    const { data } = await llm.call({ task: "findObligations", model: TASKS.findObligations.model, system: [{ text: OBLIGATIONS_SYSTEM, cache: true }], user: [{ text: obligationsUser(section, sentences, missing) }], schema: obligationsSchema, tracker, signal });
    return accountFor(data, sentences);
  };
  const first = await ask([]);
  if (!first.unexplained.length) return first;
  // every cue sentence must be accounted for: ask once more, naming the ones left out
  const second = await ask(first.unexplained);
  return second.unexplained.length <= first.unexplained.length ? second : first;
}

/** The check made from an obligation: the same shape as one part of a questionnaire question. */
export function obligationItems(sectionId: string, obligations: Obligation[]): Item[] {
  return obligations.map((o) => {
    // as in Step 7, only numbers the requirement sentence itself states are compared with quotes
    const stated = new Set(extractQuantities(o.summary).map((q) => `${q.value}|${q.unitBase}`));
    const seen = new Set<string>();
    const quantities = o.quantities
      .flatMap((q) => extractQuantities(q))
      .filter((q) => {
        const key = `${q.value}|${q.unitBase}`;
        if (!stated.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { id: o.id, parentId: sectionId, requirement: o.summary, quantities, searchTerms: o.searchTerms, allowsReference: false };
  });
}
