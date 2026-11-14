// Step 24 — check a Guide section's obligations against the policies (ARCHITECTURE.md §8).
// The section plays the part of a question, and its obligations are the parts of that question,
// so Steps 8–15 run exactly as they do for a questionnaire.
import type { ModelKey } from "../config/models";
import type { LLM, UsageTracker } from "../llm/client";
import type { Guide, GuideSection, ParentResult, Regulator } from "../types";
import { obligationItems, type Obligation } from "./findObligations";
import type { Library } from "./library";
import type { OnProgress } from "./progress";
import { runEvidence, type EvidenceRun } from "./runEvidence";

export function regulatorFromGuide(guide: Pick<Guide, "title" | "date">, section: Pick<GuideSection, "updated">): Regulator {
  // Only a section marked "Updated" is known to be as new as the Guide. For the others, a policy
  // older than the Guide may still be newer than the requirement, so no staleness is claimed.
  return { label: guide.title.replace(/^CalAIM Enhanced Care Management/, "ECM"), date: section.updated ? guide.date : null, supersedes: [], isGuide: true };
}

export const sectionHeading = (section: Pick<GuideSection, "title" | "path">) => [...section.path, section.title].join(" > ");

export async function runSectionCheck(args: {
  guide: Pick<Guide, "title" | "date">;
  section: GuideSection;
  obligations: Obligation[];
  library: Library;
  llm: LLM;
  models: { fullReading: ModelKey; secondOpinion: ModelKey };
  tracker?: UsageTracker;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  onGroupDone?: (results: ParentResult[]) => void;
}): Promise<EvidenceRun> {
  const { guide, section, obligations, ...rest } = args;
  return runEvidence({
    ...rest,
    regulator: regulatorFromGuide(guide, section),
    groups: [
      {
        parents: [
          {
            id: section.id,
            label: "POLICY GUIDE SECTION",
            text: `${sectionHeading(section)}\nThe requirements below are the obligations this section places on the plan and its providers.`,
            items: obligationItems(section.id, obligations),
            flags: [],
          },
        ],
        regulatorText: section.text,
      },
    ],
  });
}
