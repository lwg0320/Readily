// Step 22 — find the obligations in one section of a DHCS Policy Guide (ARCHITECTURE.md §8).
import { z } from "zod";
import { JSON_INSTRUCTION } from "../client";
import type { Sentence } from "../../pipeline/sentences";
import type { GuideSection } from "../../types";

export const obligationsSchema = z.object({
  obligations: z
    .array(
      z.object({
        summary: z.string().min(8),
        actor: z.preprocess((v) => (v === "plan" || v === "provider" ? v : "other"), z.enum(["plan", "provider", "other"])),
        strength: z.preprocess((v) => (v === "recommended" ? v : "binding"), z.enum(["binding", "recommended"])),
        sentenceIds: z.array(z.string()).default([]),
        quantities: z.array(z.string()).default([]),
        searchTerms: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  nonObligations: z.array(z.object({ sentenceId: z.string(), reason: z.string().default("") })).default([]),
});
export type ObligationsOutput = z.infer<typeof obligationsSchema>;

export const OBLIGATIONS_SYSTEM = `You extract obligations from ONE section of a Policy Guide written by the California Department of Health Care Services (DHCS) for Medi-Cal managed care plans ("MCPs"). A compliance analyst at a plan will check each obligation against the plan's own policy documents.

An obligation is something an MCP, or a provider working with it, must or should do.
- One sentence may contain several obligations. Create one per distinct duty.
- Several sentences may describe one duty. Create one obligation and list all of them.
- Do not create obligations for things DHCS itself will do, for background and definitions, for examples, or for what Members may choose to do.
- A description of a service is not an obligation unless the text says the MCP or a provider must or should do something about it.

For each obligation give:
- "summary": one plain, self-contained sentence that starts with who must act, for example "The MCP must authorize the Member for ECM whenever it authorizes Transitional Rent." Keep the section's own terms and any number or time limit. It must make sense to someone who has not read the section.
- "actor": "plan" for the MCP, "provider" for a provider, otherwise "other".
- "strength": "binding" for must, shall, required, may not; "recommended" for should, encouraged, expected.
- "sentenceIds": the numbered sentences it comes from.
- "quantities": numbers with units that are essential to it, for example "6 months". Usually empty.
- "searchTerms": up to 4 short, distinctive phrases that a plan policy stating this would very likely contain, copied from the section (for example a program or service name). Not generic words.

You are also given a list of "cue" sentences: sentences that contain words such as must, should or required. Every cue sentence must be accounted for. For each cue sentence that you did not use in any obligation, add an entry to "nonObligations" with a reason of at most 12 words.

${JSON_INSTRUCTION}
Shape:
{"obligations":[{"summary":"…","actor":"plan","strength":"binding","sentenceIds":["S2"],"quantities":[],"searchTerms":["…"]}],"nonObligations":[{"sentenceId":"S5","reason":"…"}]}`;

export function obligationsUser(section: Pick<GuideSection, "title" | "path" | "parentIntro">, sentences: Sentence[], missing: string[] = []): string {
  const cues = sentences.filter((s) => s.cue).map((s) => s.id);
  return `SECTION: ${[...section.path, section.title].join(" > ")}
${section.parentIntro ? `\nCONTEXT (the start of the section this one sits under; do not extract obligations from it):\n${section.parentIntro}\n` : ""}
SENTENCES:
${sentences.map((s) => `[${s.id}] (page ${s.page}${s.footnote ? ", footnote" : ""}) ${s.text}`).join("\n")}

CUE SENTENCES: ${cues.length ? cues.join(", ") : "none"}${
    missing.length ? `\n\nNOTE: an earlier answer did not account for ${missing.join(", ")}. Give the complete answer again, with each of them either in an obligation or in "nonObligations".` : ""
  }`;
}
