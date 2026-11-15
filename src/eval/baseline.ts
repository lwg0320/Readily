// The naive comparison (ARCHITECTURE.md §12): hand the model the two obvious policies and the
// question, and ask for yes or no with a citation. No checklist, no reading of every policy,
// no checks on the quote, no second opinion. It shows what the pipeline's extra steps buy.
import { z } from "zod";
import type { ModelKey } from "../config/models";
import { JSON_INSTRUCTION, type LLM, type UsageTracker } from "../llm/client";
import { verifyQuote } from "../lib/quotes";
import type { Policy, Question } from "../types";
import type { BaselineAnswer } from "./score";

export const BASELINE_POLICIES = ["GG.1503", "GG.1550"];

const schema = z.object({
  answer: z.preprocess((v) => (String(v).toLowerCase().startsWith("y") ? "yes" : "no"), z.enum(["yes", "no"])),
  citation: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()),
  quote: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()),
});

const SYSTEM = "You are a compliance analyst for a Medi-Cal managed care plan. You answer a regulator's question from the plan's policy documents (P&Ps).";

export async function runBaseline(args: { questions: Question[]; policies: Policy[]; model: ModelKey; llm: LLM; tracker?: UsageTracker; signal?: AbortSignal }): Promise<BaselineAnswer[]> {
  const { questions, policies, model, llm, tracker, signal } = args;
  const documents = { text: `POLICY DOCUMENTS\n\n${policies.map((p) => p.canonicalText).join("\n\n=====\n\n")}`, cache: true };
  const results = await llm.warmThenAll(
    questions.map(
      (q) => () =>
        llm.call({
          task: "baseline",
          model,
          system: [{ text: SYSTEM }],
          user: [documents, { text: `QUESTION ${q.number}: ${q.text}\n\nDoes the P&P state this? Answer yes or no with a citation.\n\n${JSON_INSTRUCTION}\nShape:\n{"answer":"yes","citation":"GG.1503 §II.A, page 1","quote":"the exact policy text that supports the answer, or an empty string"}` }],
          schema,
          tracker,
          signal,
        }),
    ),
  );
  const answers: BaselineAnswer[] = [];
  results.forEach((r, i) => {
    if (r instanceof Error) return;
    const quote = r.data.quote.trim();
    answers.push({ question: questions[i].number, answer: r.data.answer, citation: r.data.citation.trim(), quote, quoteFound: !!quote && policies.some((p) => verifyQuote(p, quote).status !== "rejected") });
  });
  return answers;
}
