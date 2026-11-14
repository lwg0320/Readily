// Steps 11 and 13 — full reading and second opinion (ARCHITECTURE.md §8).
// Both steps send the SAME system text and the SAME first block (documents + regulator text),
// so the second opinion reads the documents from the cache the full reading wrote.
import { z } from "zod";
import { JSON_INSTRUCTION } from "../client";
import type { Evidence, Flag, Item, ItemStatus } from "../../types";

export const READING_SYSTEM = `You are a careful compliance analyst for a Medi-Cal managed care plan (CalOptima Health; regulators call it "the MCP"). You will be given some of the plan's policy documents (P&Ps) and regulator text, followed by a task. Every task asks whether the policy documents state certain requirements.

Ground rules:
- Policy text is evidence. Regulator text is never evidence; it is there so you understand what a requirement means.
- Quote only exact, contiguous text from the policy documents.
- In the policy text, a first line like [[GG.1503 | title | Applies to: … | Revised …]] is a header and lines like <<page 3>> are page markers. Never include them in a quote.
- Each policy says which programs it applies to. Inside a policy, text under a heading for another program (for example a "Medicare …" or "OneCare …" heading) does not apply to Medi-Cal members.
- Capitalised terms such as "Hospice Care" are defined in the policy's Glossary. A definition is part of what the policy states: a policy sentence that uses a defined term says everything the definition says.
- Each task covers only some of the plan's policies. Text that is merely missing from these documents is never a problem in itself.

The standard for every answer:
- "covered": policy text that applies to Medi-Cal members states every element of the requirement: who must act, what must be done or provided, and any number, deadline or condition the requirement names.
  - Different words are fine when they mean the same thing. So is a broader term that clearly includes the requirement's term ("counseling" includes grief counseling). A narrower term is not enough, and neither is text that leaves an element of the requirement out.
  - The elements may be stated in different places, for example a policy sentence together with a Glossary definition.
  - A policy that states the requirement as its rule still states it when it also has a carve-out for a particular group or situation (for example different rules for Members under 21), eligibility conditions, or steps for carrying the rule out. That is a defect only when it contradicts what the requirement itself says about that same group or situation.
- "conflict": a policy sets a different rule for the same action or subject as the requirement: a different deadline, amount or responsible party, or permission for something the requirement rules out. A looser rule is a conflict even when both could be satisfied at once: a policy that allows 60 days where the requirement allows 14 conflicts with it. Text about a different subject is never a conflict.
- "not_covered": everything else, including a policy that states only part of the requirement, and silence.`;

/** The shared, cached block: the documents, then the regulator text. */
export function documentsBlock(policies: { policyId: string; text: string }[], regulatorLabel: string, regulatorText: string): string {
  const docs = policies.map((p) => `===== POLICY ${p.policyId} =====\n${p.text.trim()}\n===== END OF ${p.policyId} =====`).join("\n\n");
  return `POLICY DOCUMENTS (the plan's evidence)\n\n${docs}\n\nREGULATOR TEXT (${regulatorLabel}) — not evidence, for understanding the requirements only\n\n${regulatorText.trim()}`;
}

/**
 * A list of quotes as the model wrote it. A malformed entry (a missing or misnamed field) is
 * dropped instead of making the whole reply unusable.
 */
const evidenceList = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const policyId = o.policyId ?? o.policy_id ?? o.policy ?? o.source;
    const quote = o.quote ?? o.text;
    return typeof policyId === "string" && typeof quote === "string" ? [{ policyId, quote }] : [];
  });
}, z.array(z.object({ policyId: z.string(), quote: z.string() })));

// ------------------------------------------------------------------ Step 11

export const readerSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      status: z.enum(["covered", "not_covered", "conflict"]),
      wording: z.enum(["same", "equivalent"]).default("same"),
      evidence: evidenceList,
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

For each requirement, decide whether the policy documents above state it, using the standard in your instructions.

Rules:
1. Evidence must come from a policy that applies to Medi-Cal and from text that applies to Medi-Cal members.
2. Read whole documents. Check definitions in the Glossary. Look for other passages that narrow or contradict the evidence, and take them into account.
3. If the policy's words differ from the requirement's but mean the same, or are broader, set "wording" to "equivalent" and name both terms in the reason (for example: policy says "hospice physician", requirement says "hospice medical director").
4. For a "conflict", quote the conflicting text.
5. If a requirement includes a number or a deadline, a quote must show that number.
6. Quotes: exact contiguous text copied from one policy, at most 80 words each, no ellipses, at most 3 per requirement. Quote the sentence or list entry that states the requirement, not a heading. Inside the JSON, write any double quote that is part of a quote as \\".
7. "not_covered" has no evidence. Do not guess, and do not stretch related text to fit. If an element of the requirement is missing, say which one in the reason.
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
      newEvidence: evidenceList,
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

const proposalBlock = (p: ProposedAnswer) => {
  const quotes = p.evidence.length
    ? p.evidence.map((e) => `   - ${e.policyId} §${e.address}, p.${e.page}: "${e.quote}"`).join("\n")
    : "   (no evidence)";
  const checks = p.flags.filter((f) => f.code === "number_mismatch" || f.code === "number_not_shown" || f.code === "wrong_program_removed");
  return { quotes, notes: checks.length ? `\n   Automatic checks: ${checks.map((f) => f.detail).join("; ")}` : "" };
};

/** The first reader's reasoning is deliberately left out. */
export function reviewerTask(parent: { label: string; text: string }, proposed: ProposedAnswer[]): string {
  const blocks = proposed
    .map((p) => {
      const { quotes, notes } = proposalBlock(p);
      return `${p.item.id}: ${p.item.requirement}\n   Proposed: ${STATUS_WORDS[p.status]}\n${quotes}${notes}`;
    })
    .join("\n\n");

  return `TASK: SECOND OPINION

${parent.label}:
${parent.text}

Another analyst proposed the answers below. Check each one against the policy documents yourself and look hard for errors in it; do not trust the proposal.

${blocks}

For each requirement:
- If the proposal is "covered": does policy text really state every element of the requirement? Is the policy's term narrower? Does another passage contradict it? Does the text apply to Medi-Cal members? Does any number or deadline match?
- If the proposal is "conflict": is the quoted text about the same action or subject as the requirement, and does it set a different rule?
- If the proposal is "not_covered" or "needs_review": search the documents for evidence that was missed. If you find some, quote it in "newEvidence".
- "proposedStatus" is the answer you would give under the standard in your instructions: "covered", "not_covered" or "conflict". "agrees" is true if that is the proposed answer.
- Disagree only for a real defect under the standard, and name it in "reason" (at most 40 words). Points the standard accepts, such as a broader term, a carve-out for a particular group, or elements stated in two places, are not defects.
- "newEvidence" entries have the form {"policyId":"GG.1503","quote":"…"}: exact contiguous policy text, at most 80 words each, at most 3, with any double quote inside written as \\". Use [] when you have none.

Answer for every requirement.

${JSON_INSTRUCTION}
Shape:
{"items":[{"itemId":"${proposed[0]?.item.id ?? "Q1-01"}","agrees":true,"proposedStatus":"covered","reason":"…","newEvidence":[]}]}`;
}

// ------------------------------------------------------------------ Step 13, tie-break

export const tieBreakSchema = z.object({
  items: z.array(z.object({ itemId: z.string(), status: z.enum(["covered", "not_covered", "conflict"]), reason: z.string().default("") })),
});
export type TieBreakOutput = z.infer<typeof tieBreakSchema>;

export type Dispute = ProposedAnswer & { readerReason: string; reviewerStatus: "covered" | "not_covered" | "conflict"; reviewerReason: string };

/** Asked only about requirements on which the full reading and the second opinion disagree. */
export function tieBreakTask(parent: { label: string; text: string }, disputes: Dispute[]): string {
  const blocks = disputes
    .map((d) => {
      const { quotes } = proposalBlock(d);
      return `${d.item.id}: ${d.item.requirement}\n   Analyst A says: ${d.status}. ${d.readerReason}\n${quotes}\n   Analyst B says: ${d.reviewerStatus}. ${d.reviewerReason}`;
    })
    .join("\n\n");

  return `TASK: TIE-BREAK

${parent.label}:
${parent.text}

Two analysts read the policy documents above and disagree about the requirements below. Settle each one from the documents yourself.

${blocks}

For each requirement, give the answer that is correct under the standard in your instructions: "covered", "not_covered" or "conflict". Test Analyst B's objection against that standard: is it a real defect, or a point the standard accepts? Test Analyst A's quotes the same way: do they state every element of the requirement? "reason" is at most 40 words and says what decided it.

Answer for every requirement.

${JSON_INSTRUCTION}
Shape:
{"items":[{"itemId":"${disputes[0]?.item.id ?? "Q1-01"}","status":"covered","reason":"…"}]}`;
}
