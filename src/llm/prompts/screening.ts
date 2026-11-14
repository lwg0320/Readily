// Step 9 — read one policy against a bundle of requirements (ARCHITECTURE.md §8).
import { z } from "zod";
import { JSON_INSTRUCTION } from "../client";
import type { Item } from "../../types";

export const screeningSchema = z.object({
  hits: z
    .array(
      z.object({
        itemId: z.string(),
        address: z.string().default(""),
        strength: z.enum(["direct", "maybe"]).default("maybe"),
      }),
    )
    .default([]),
});
export type ScreeningOutput = z.infer<typeof screeningSchema>;

/** Identical for every policy in a bundle, so it is cached. */
export function screeningSystem(items: Item[]): string {
  const list = items.map((i) => `${i.id}: ${i.requirement}`).join("\n");
  return `You are screening ONE policy document of a Medi-Cal managed care plan (CalOptima Health; regulators call it "the MCP") against a list of requirements from the regulator.

Report which requirements this document addresses, even partly, and where. A later, careful reader will read the documents you point to in full, so your job is not to miss anything:
- If you are unsure whether the document addresses a requirement, include it.
- The document may use different words from the requirement. Match on meaning, not wording.
- Evidence can be anywhere: the Policy and Procedure sections, a definition in the Glossary, or the References list.
- Give the section address as written in the document, for example "II.C.2", "III.F.1" or "Glossary: Hospice Care".
- "strength" is "direct" if the document clearly speaks to the requirement, "maybe" if it is only related.
- If the document addresses none of the requirements, return an empty list. Most documents address none.
- Lines like <<page 3>> are page markers, not text.

REQUIREMENTS
${list}

${JSON_INSTRUCTION} Do not explain.
Shape:
{"hits":[{"itemId":"${items[0]?.id ?? "Q1-01"}","address":"II.C.2","strength":"direct"}]}`;
}

export function screeningUser(policyText: string): string {
  return `POLICY DOCUMENT\n\n${policyText}`;
}
