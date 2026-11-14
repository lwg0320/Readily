// Orchestrates Steps 7–15 for a DHCS questionnaire (ARCHITECTURE.md §8).
import type { ModelKey } from "../config/models";
import type { LLM, UsageTracker } from "../llm/client";
import type { Apl, ParentResult, Question, Regulator } from "../types";
import { buildChecklists, type QuestionChecklist } from "./checklist";
import { groupQuestions } from "./grouping";
import type { Library } from "./library";
import type { OnProgress } from "./progress";
import { runEvidence, type EvidenceRun, type Group } from "./runEvidence";

export type QuestionnaireRun = EvidenceRun & { checklists: QuestionChecklist[]; groups: number[][] };

export function regulatorFromApl(apl: Apl): Regulator {
  return { label: `APL ${apl.number}`, date: apl.date, supersedes: apl.supersedes, isGuide: false };
}

/** The APL pages a group's questions cite, in order, as the "regulator text" for Steps 11 and 13. */
export function aplTextFor(apl: Apl, questions: Question[]): string {
  const pages = [...new Set(questions.flatMap((q) => q.aplPages))].sort((a, b) => a - b);
  return apl.pages
    .filter((p) => pages.includes(p.page))
    .map((p) => `<<APL ${apl.number} page ${p.page}>>\n${p.text}`)
    .join("\n\n");
}

export async function runQuestionnaire(args: {
  questions: Question[];
  apl: Apl;
  library: Library;
  llm: LLM;
  models: { fullReading: ModelKey; secondOpinion: ModelKey };
  tracker?: UsageTracker;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  onChecklists?: (checklists: QuestionChecklist[]) => void;
  onGroupDone?: (results: ParentResult[]) => void;
}): Promise<QuestionnaireRun> {
  const { questions, apl, library, llm, models, tracker, signal, onProgress, onChecklists, onGroupDone } = args;

  // Step 7
  const checklists = await buildChecklists({ questions, apl, llm, tracker, signal, onProgress });
  onChecklists?.(checklists);
  const byNumber = new Map(checklists.map((c) => [c.question.number, c]));

  // Step 8
  const groupNumbers = groupQuestions(questions);
  const groups: Group[] = groupNumbers.map((numbers) => {
    const members = numbers.map((n) => byNumber.get(n)!);
    return {
      parents: members.map((c) => ({
        id: String(c.question.number),
        label: `QUESTION ${c.question.number}`,
        text: c.question.text,
        items: c.items,
        flags: c.flags,
      })),
      regulatorText: aplTextFor(apl, members.map((c) => c.question)),
    };
  });

  // Steps 9–15
  const run = await runEvidence({ groups, regulator: regulatorFromApl(apl), library, llm, models, tracker, signal, onProgress, onGroupDone });
  const order = new Map(questions.map((q, i) => [String(q.number), i]));
  run.results.sort((a, b) => order.get(a.parentId)! - order.get(b.parentId)!);
  return { ...run, checklists, groups: groupNumbers };
}
