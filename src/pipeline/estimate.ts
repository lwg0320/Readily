// Price and time before the click (ARCHITECTURE.md §10.5).
// The token counts are averages measured on a full run of the 64-question APL 25-008
// questionnaire (211 checks, 251 Medi-Cal policies, November 2026).
import { MODELS, TASKS, type ModelKey } from "../config/models";
import { PIPELINE } from "../config/pipeline";

type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number };
const price = (model: ModelKey, t: Tokens) => {
  const p = MODELS[model].price;
  return (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1_000_000;
};

const PER_QUESTION = {
  checks: 3.3,
  checklist: { input: 1300, cacheWrite: 15, cacheRead: 765, output: 1080 },
  fullReading: { input: 9400, cacheWrite: 42_300, cacheRead: 492_000, output: 8500 },
  secondOpinion: { input: 4800, cacheWrite: 0, cacheRead: 309_000, output: 9400 },
  readingCalls: 9.2, // full-reading, second-opinion and tie-break calls together
};
/** One pass over every policy for one bundle of checks. */
const PER_POLICY_PER_BUNDLE = { input: 8150, cacheWrite: 20, cacheRead: 4880, output: 140 };

export type Estimate = { cost: number; minutes: number };

type Choice = { fullReading: ModelKey; secondOpinion: ModelKey };

/**
 * `reuse`: the settings of a run already finished in this browser. Its saved work is not paid
 * for again: the checklists and the pass over every policy always, the full reading if its
 * setting is unchanged, and the second opinion only if both settings are unchanged (a second
 * opinion is given on a particular reading, so a new reading needs a new one).
 */
export function estimateQuestionnaire(args: { questions: number; mediCalPolicies: number; models: Choice; reuse?: Choice }): Estimate {
  const { questions, mediCalPolicies, models, reuse } = args;
  const scale = (t: Tokens, n: number): Tokens => ({ input: t.input * n, cacheWrite: t.cacheWrite * n, cacheRead: t.cacheRead * n, output: t.output * n });
  const bundles = Math.max(1, Math.min(PIPELINE.bundles, Math.ceil((questions * PER_QUESTION.checks) / PIPELINE.itemsPerBundle)));
  const screeningCalls = bundles * mediCalPolicies;

  // with different models, the second opinion cannot reuse the full reading's cached policies
  const second: Tokens =
    models.fullReading === models.secondOpinion
      ? PER_QUESTION.secondOpinion
      : { ...PER_QUESTION.secondOpinion, cacheWrite: PER_QUESTION.fullReading.cacheWrite, cacheRead: PER_QUESTION.secondOpinion.cacheRead - PER_QUESTION.fullReading.cacheWrite };

  const readingAgain = !reuse || reuse.fullReading !== models.fullReading;
  const secondAgain = readingAgain || reuse!.secondOpinion !== models.secondOpinion;
  // a second opinion asked for on its own finds no cached policies waiting, whatever the models
  const secondAlone: Tokens = { ...second, cacheWrite: PER_QUESTION.fullReading.cacheWrite };
  if (reuse && !secondAgain) return { cost: 0, minutes: 1 };

  const cost =
    (reuse ? 0 : price(TASKS.checklist.model, scale(PER_QUESTION.checklist, questions)) + price(TASKS.readEveryPolicy.model, scale(PER_POLICY_PER_BUNDLE, screeningCalls))) +
    (readingAgain ? price(models.fullReading, scale(PER_QUESTION.fullReading, questions)) : 0) +
    price(models.secondOpinion, scale(readingAgain ? second : secondAlone, questions));

  // measured: about 2 s per first-pass call and 10 s per reading call, shared among the parallel slots;
  // one group's chain of reading, second opinion and last look takes about 3 minutes however many slots there are
  const readingCalls = questions * PER_QUESTION.readingCalls * (readingAgain ? 1 : 0.5);
  const seconds = ((reuse ? 0 : screeningCalls * 2) + readingCalls * 10) / PIPELINE.concurrency + 180;
  return { cost, minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

/**
 * Checking one Guide section's obligations (Step 24). Nearly all of it is reading every policy
 * once; the full reading and second opinion of a handful of obligations add a few cents.
 */
export function estimateSectionCheck(args: { obligations: number; mediCalPolicies: number; models: { fullReading: ModelKey; secondOpinion: ModelKey } }): Estimate {
  const { obligations, mediCalPolicies, models } = args;
  const scale = (t: Tokens, n: number): Tokens => ({ input: t.input * n, cacheWrite: t.cacheWrite * n, cacheRead: t.cacheRead * n, output: t.output * n });
  const perCheck = 1 / PER_QUESTION.checks; // a question has about 3.3 checks
  const sets = Math.max(1, Math.ceil(obligations / 8)); // sets of policies read in full
  const second: Tokens = models.fullReading === models.secondOpinion ? PER_QUESTION.secondOpinion : { ...PER_QUESTION.secondOpinion, cacheWrite: PER_QUESTION.fullReading.cacheWrite };
  const cost =
    price(TASKS.readEveryPolicy.model, scale({ ...PER_POLICY_PER_BUNDLE, cacheRead: 600 }, mediCalPolicies)) +
    price(models.fullReading, { ...scale(PER_QUESTION.fullReading, obligations * perCheck), cacheWrite: sets * 55_000 }) +
    price(models.secondOpinion, { ...scale(second, obligations * perCheck), cacheWrite: second.cacheWrite ? sets * 55_000 : 0 });
  const seconds = (mediCalPolicies * 2) / PIPELINE.concurrency + 150;
  return { cost, minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

/** "$2.30", "$48", "under $0.01" */
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "under $0.01";
  if (cost >= 20) return `$${Math.round(cost)}`;
  return `$${cost.toFixed(2)}`;
}
