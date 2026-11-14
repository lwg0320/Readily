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

Report the requirements for which this document contains a specific passage that a careful reader should look at, and where that passage is. A later reader will read the documents you point to in full, so do not miss such a passage:
- The passage may use different words from the requirement. Match on meaning, not wording.
- It can be anywhere: the Policy and Procedure sections, a definition in the Glossary, or the References list.
- Give the section address as written in the document, for example "II.C.2", "III.F.1" or "Glossary: Hospice Care".
- "strength" is "direct" if the passage states the requirement or part of it, or sets a different rule for the same thing (for example a different deadline). It is "maybe" if the passage is about the same specific matter but you are not sure it states the requirement.
- Sharing a broad subject is not enough. A requirement about one particular service, form, deadline or situation is not addressed by a document that only deals with covered services, providers, payment or authorization in general. Do not report it.
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
