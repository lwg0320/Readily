// Step 7 — checklist (ARCHITECTURE.md §8). One call per question.
import type { LLM, UsageTracker } from "../llm/client";
import { LLMError } from "../llm/client";
import { CHECKLIST_SYSTEM, checklistSchema, checklistUser, type ChecklistOutput } from "../llm/prompts/checklist";
import { extractQuantities } from "../lib/text";
import type { Apl, Flag, Item, Question } from "../types";
import type { OnProgress } from "./progress";

export type QuestionChecklist = { question: Question; items: Item[]; flags: Flag[] };

export function toItems(question: Question, out: ChecklistOutput): Item[] {
  return out.items.map((it, i) => {
    const requirement = it.requirement.trim();
    // Units are parsed by our own code so they compare cleanly with quoted text later. Only
    // numbers the requirement sentence itself states are kept: the model sometimes adds
    // numbers from the surrounding APL text, and a quote cannot be expected to show those.
    const stated = new Set(extractQuantities(requirement).map((q) => `${q.value}|${q.unitBase}`));
    return {
      id: `Q${question.number}-${String(i + 1).padStart(2, "0")}`,
      parentId: String(question.number),
      requirement,
      quantities: dedupe(it.quantities.flatMap((q) => extractQuantities(q))).filter((q) => stated.has(`${q.value}|${q.unitBase}`)),
      searchTerms: [...new Set(it.searchTerms.map((t) => t.trim()).filter(Boolean))].slice(0, 4),
      allowsReference: it.allowsReference,
    };
  });
}

function dedupe<T extends { value: number; unitBase: string }>(qs: T[]): T[] {
  const seen = new Set<string>();
  return qs.filter((q) => {
    const k = `${q.value}|${q.unitBase}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function buildChecklists(args: {
  questions: Question[];
  apl: Apl;
  llm: LLM;
  tracker?: UsageTracker;
  signal?: AbortSignal;
  onProgress?: OnProgress;
}): Promise<QuestionChecklist[]> {
  const { questions, apl, llm, tracker, signal, onProgress } = args;
  const label = `APL ${apl.number}`;
  let done = 0;

  const one = async (question: Question, nudge = ""): Promise<{ out: ChecklistOutput; fromSavedCache: boolean }> => {
    const pages = apl.pages.filter((p) => question.aplPages.includes(p.page));
    const r = await llm.call({
      task: "checklist",
      system: [{ text: CHECKLIST_SYSTEM, cache: true }],
      user: [{ text: checklistUser(question, pages, label) + nudge }],
      schema: checklistSchema,
      tracker,
      signal,
    });
    return { out: r.data, fromSavedCache: r.fromSavedCache };
  };

  const results = await llm.warmThenAll(
    questions.map((question) => async () => {
      let { out, fromSavedCache } = await one(question);
      const flags: Flag[] = [];
      const listed = () => out.items.filter((i) => i.fromList).length;
      if (out.listCount !== null && listed() !== out.listCount) {
        // the question names a count ("the 12 listed services"): the list must have that many entries
        const again = await one(
          question,
          `\n\nNOTE: the question names ${out.listCount} listed entries, but a previous attempt produced ${listed()}. Find the list in the pages above and create exactly one item per entry.`,
        );
        out = again.out;
        if (out.listCount !== null && listed() !== out.listCount) {
          flags.push({ code: "list_count_mismatch", detail: `The question names ${out.listCount} listed entries; ${listed()} were found in the APL pages.` });
        }
      }
      onProgress?.({ stage: "checklist", done: ++done, total: questions.length });
      return { question, items: toItems(question, out), flags, fromSavedCache };
    }),
  );

  return results.map((r, i) => {
    if (!(r instanceof LLMError)) return { question: r.question, items: r.items, flags: r.flags };
    // Fall back to the whole question as a single requirement, clearly flagged.
    const q = questions[i];
    return {
      question: q,
      items: [{ id: `Q${q.number}-01`, parentId: String(q.number), requirement: q.text, quantities: extractQuantities(q.text), searchTerms: [], allowsReference: false }],
      flags: [{ code: "analysis_failed", detail: "The question could not be split into a checklist; it was checked as one requirement." }],
    };
  });
}
