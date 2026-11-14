// Steps 11 and 13 — full reading and second opinion (ARCHITECTURE.md §8).
// Both steps send the SAME system text and the SAME first block (documents + regulator text),
// so the second opinion reads the documents from the cache the full reading wrote.
import { z } from "zod";
import { JSON_INSTRUCTION } from "../client";
import type { Evidence, Flag, Item, ItemStatus } from "../../types";

export const READING_SYSTEM = `You are a careful compliance analyst for a Medi-Cal managed care plan (CalOptima Health; regulators call it "the MCP"). You will be given some of the plan's policy documents (P&Ps) and regulator text, followed by a task.

Ground rules:
- Policy text is evidence. Regulator text is never evidence.
- Quote only exact, contiguous text from the policy documents.
- In the policy text, a first line like [[GG.1503 | title | Applies to: … | Revised …]] is a header and lines like <<page 3>> are page markers. Never include them in a quote.
- Each policy says which programs it applies to. Inside a policy, text under a heading for another program (for example a "Medicare …" or "OneCare …" heading) does not apply to Medi-Cal members.`;

/** The shared, cached block: the documents, then the regulator text. */
export function documentsBlock(policies: { policyId: string; text: string }[], regulatorLabel: string, regulatorText: string): string {
  const docs = policies.map((p) => `===== POLICY ${p.policyId} =====\n${p.text.trim()}\n===== END OF ${p.policyId} =====`).join("\n\n");
  return `POLICY DOCUMENTS (the plan's evidence)\n\n${docs}\n\nREGULATOR TEXT (${regulatorLabel}) — not evidence, for understanding the requirements only\n\n${regulatorText.trim()}`;
}

// ------------------------------------------------------------------ Step 11

export const readerSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      status: z.enum(["covered", "not_covered", "conflict"]),
      wording: z.enum(["same", "equivalent"]).default("same"),
      evidence: z.array(z.object({ policyId: z.string(), quote: z.string() })).default([]),
      reason: z.string().default(""),
    }),
  ),
});
export type ReaderOutput = z.infer<typeof readerSchema>;

const itemList = (items: Item[]) => items.map((i) => `${i.id}: ${i.requirement}`).join("\n");

export function readerTask(parent: { label: string; text: string }, items: Item[]): string {
  return `TASK: FULL READING

${parent.label}:
${parent.text}

It has been split into these requirements:
${itemList(items)}

For each requirement, decide whether the policy documents above state it.

Rules:
1. Evidence must come from a policy that applies to Medi-Cal and from text that applies to Medi-Cal members.
2. Read whole documents. Check definitions in the Glossary. Look for conditions, exceptions or other passages that narrow or contradict the evidence, and take them into account.
3. Different wording is fine only if it means the same thing. Then set "wording" to "equivalent" and name both terms in the reason (for example: policy says "hospice physician", requirement says "hospice medical director"). If the policy's term is narrower than the requirement, the requirement is not covered.
4. If the policy states something incompatible with the requirement (for example a different deadline for the same action), the status is "conflict" and you must quote the conflicting text.
5. If a requirement includes a number or a deadline, a quote must show that number.
6. Quotes: exact contiguous text copied from one policy, at most 80 words each, no ellipses, at most 3 per requirement. Quote the sentence or list entry that states the requirement, not a heading.
7. If nothing in the documents states the requirement, the status is "not_covered" with no evidence. Do not guess, and do not stretch related text to fit.
8. A requirement that only asks the P&P to reference a document is covered when the document is named anywhere in a policy, including its References list.

Answer for every requirement. "reason" is at most 40 words.

${JSON_INSTRUCTION}
Shape:
{"items":[{"itemId":"${items[0]?.id ?? "Q1-01"}","status":"covered","wording":"same","evidence":[{"policyId":"GG.1503","quote":"…"}],"reason":"…"}]}`;
}

// ------------------------------------------------------------------ Step 13

export const reviewerSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      agrees: z.boolean(),
      proposedStatus: z.enum(["covered", "not_covered", "conflict"]),
      reason: z.string().default(""),
      newEvidence: z.array(z.object({ policyId: z.string(), quote: z.string() })).default([]),
    }),
  ),
});
export type ReviewerOutput = z.infer<typeof reviewerSchema>;

export type ProposedAnswer = { item: Item; status: ItemStatus; evidence: Evidence[]; flags: Flag[] };

const STATUS_WORDS: Record<ItemStatus, string> = {
  covered: "covered",
  not_covered: "not_covered (no acceptable evidence was found)",
  conflict: "conflict (the policy states something incompatible)",
  needs_review: "needs_review (evidence exists but an automatic check raised a problem)",
};

/** The first reader's reasoning is deliberately left out. */
export function reviewerTask(parent: { label: string; text: string }, proposed: ProposedAnswer[]): string {
  const blocks = proposed
    .map((p) => {
      const quotes = p.evidence.length
        ? p.evidence.map((e) => `   - ${e.policyId} §${e.address}, p.${e.page}: "${e.quote}"`).join("\n")
        : "   (no evidence)";
      const checks = p.flags.filter((f) => f.code === "number_mismatch" || f.code === "number_not_shown" || f.code === "wrong_program_removed");
      const notes = checks.length ? `\n   Automatic checks: ${checks.map((f) => f.detail).join("; ")}` : "";
      return `${p.item.id}: ${p.item.requirement}\n   Proposed: ${STATUS_WORDS[p.status]}\n${quotes}${notes}`;
    })
    .join("\n\n");

  return `TASK: SECOND OPINION

${parent.label}:
${parent.text}

Another analyst proposed the answers below. Your job is to find reasons each answer is wrong. Re-read the policy documents yourself; do not trust the proposal.

${blocks}

For each requirement:
- If the proposal is "covered" or "conflict": does the quoted text really prove the WHOLE requirement? Is its scope narrower than the requirement? Does another passage add a condition or an exception? Does it apply to Medi-Cal members? Does any number or deadline match?
- If the proposal is "not_covered" or "needs_review": search the documents for evidence that was missed. If you find some, quote it exactly in "newEvidence" (exact contiguous policy text, at most 80 words each, at most 3).
- "agrees" is true only if you would give the same answer after your own reading. "proposedStatus" is the answer you would give: "covered", "not_covered" or "conflict".
- "reason" is at most 40 words and must be specific.

Answer for every requirement.

${JSON_INSTRUCTION}
Shape:
{"items":[{"itemId":"${proposed[0]?.item.id ?? "Q1-01"}","agrees":true,"proposedStatus":"covered","reason":"…","newEvidence":[]}]}`;
}
