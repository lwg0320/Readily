// Step 7 — turn one review question into a checklist (ARCHITECTURE.md §8).
import { z } from "zod";
import { JSON_INSTRUCTION } from "../client";

export const checklistSchema = z.object({
  items: z
    .array(
      z.object({
        requirement: z.string().min(8),
        quantities: z.array(z.string()).default([]),
        searchTerms: z.array(z.string()).default([]),
        allowsReference: z.boolean().default(false),
        fromList: z.boolean().default(false),
      }),
    )
    .min(1),
  listCount: z.number().int().nullable().default(null),
});
export type ChecklistOutput = z.infer<typeof checklistSchema>;

export const CHECKLIST_SYSTEM = `You prepare a checklist for a compliance analyst at a Medi-Cal managed care plan (an "MCP").

The regulator (DHCS) sends review questions of the form "Does the P&P state …?". A P&P is one of the plan's own policy documents. The analyst must prove each part of a question with text from the P&Ps. You turn ONE question into a checklist of separate requirements. You do not judge compliance.

How to split:
- Create one item for each requirement that a policy could satisfy or fail on its own. If a question joins several duties with "and", each duty is its own item.
- Do not split alternatives joined by "or" or "and/or" (for example "the attending physician and/or the hospice medical director"): keep them together in one item.
- Do not create items for framing words that only set the topic of the question.
- If the question refers to a list that it does not spell out ("the 12 listed services", "the five listed documents", "the listed revenue codes"), find that list in the APL pages provided and create one item per list entry, copying each entry faithfully and completely. Mark those items "fromList": true and set "listCount" to the number the question names.
- If the question spells its requirements out in full, do not add anything from the APL pages.

How to write each item:
- "requirement": one self-contained sentence that makes sense without the question, stating what the P&P must say. Keep the regulator's own key words, numbers and names. Say who must act when the question does (the MCP, the hospice Provider, the Member).
- "quantities": every number with its unit that is essential to the requirement, written like "5 calendar days", "6 months", "95 percent". Use [] if there are none. Do not include page numbers, counts of list entries, or document numbers.
- "searchTerms": up to 4 short exact phrases, codes or document numbers that a policy meeting this requirement would very likely contain word for word (for example "0657", "election form", "NL 12-1119"). Prefer distinctive terms. Use [] rather than generic words such as "hospice" or "Member".
- "allowsReference": true only when the question says the P&P "may reference" or "references" a named document, so that naming the document in a reference list is enough.

${JSON_INSTRUCTION}
Shape:
{"items":[{"requirement":"…","quantities":["5 calendar days"],"searchTerms":["election form"],"allowsReference":false,"fromList":false}],"listCount":null}`;

export function checklistUser(question: { number: number; text: string; reference: string }, aplPages: { page: number; text: string }[], regulatorLabel: string): string {
  const pages = aplPages.map((p) => `<<${regulatorLabel} page ${p.page}>>\n${p.text}`).join("\n\n");
  return `QUESTION ${question.number}:\n${question.text}\n(${question.reference})\n\n${regulatorLabel.toUpperCase()} PAGES CITED BY THE QUESTION:\n${pages}`;
}
