// Everything the pipeline needs to know about the plan's documents.
import { createSearch, type Search } from "../lib/search";
import type { Policy } from "../types";

export type Library = {
  /** Medi-Cal policies by ID. Only these are ever read or cited. */
  policies: Map<string, Policy>;
  mediCal: Policy[];
  search: Search;
};

export function createLibrary(policies: Policy[], searchIndexJson: string | null): Library {
  const mediCal = policies.filter((p) => p.programs.mediCal).sort((a, b) => a.id.localeCompare(b.id));
  return {
    policies: new Map(mediCal.map((p) => [p.id, p])),
    mediCal,
    search: createSearch(mediCal, searchIndexJson),
  };
}
