import fs from "node:fs";
import path from "node:path";
import type { Apl, Guide, Item, Policy, Questionnaire, Regulator } from "../src/types";

const DATA = path.resolve(__dirname, "../public/data");
const cache = new Map<string, Policy>();

export function loadPolicy(id: string): Policy {
  if (!cache.has(id)) cache.set(id, JSON.parse(fs.readFileSync(path.join(DATA, "policies", `${id}.json`), "utf8")));
  return cache.get(id)!;
}
export const loadApl = (): Apl => JSON.parse(fs.readFileSync(path.join(DATA, "apl", "APL25-008.json"), "utf8"));
export const loadQuestionnaire = (): Questionnaire => JSON.parse(fs.readFileSync(path.join(DATA, "questionnaires", "apl-25-008.json"), "utf8"));
export const loadGuide = (): Guide => JSON.parse(fs.readFileSync(path.join(DATA, "guides", "ecm-2026-01.json"), "utf8"));
export const loadSearchIndex = (): string => fs.readFileSync(path.join(DATA, "search-index.json"), "utf8");

export function policyMap(...ids: string[]): Map<string, Policy> {
  return new Map(ids.map((id) => [id, loadPolicy(id)]));
}

export const APL_25_008: Regulator = { label: "APL 25-008", date: "2025-05-05", supersedes: ["13-014"], isGuide: false };

export function item(over: Partial<Item> & { id: string }): Item {
  return { parentId: over.id.split("-")[0], requirement: "", quantities: [], searchTerms: [], allowsReference: false, ...over };
}
