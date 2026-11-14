// Loads the prepared data from public/data for command-line runs.
import fs from "node:fs";
import path from "node:path";
import { createLibrary, type Library } from "../../src/pipeline/library";
import type { Apl, Guide, Policy, Questionnaire } from "../../src/types";
import { REPO_ROOT } from "./env";

const DATA = path.join(REPO_ROOT, "public", "data");
const read = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(DATA, ...parts), "utf8"));

export function loadLibrary(): Library {
  const lib = read<{ policies: { id: string; programs: { mediCal: boolean } }[] }>("library.json");
  const policies = lib.policies.filter((p) => p.programs.mediCal).map((p) => read<Policy>("policies", `${p.id}.json`));
  return createLibrary(policies, fs.readFileSync(path.join(DATA, "search-index.json"), "utf8"));
}
export const loadQuestionnaire = (id: string) => read<Questionnaire>("questionnaires", `${id}.json`);
export const loadApl = (id: string) => read<Apl>("apl", `${id}.json`);
export const loadGuide = (id: string) => read<Guide>("guides", `${id}.json`);
