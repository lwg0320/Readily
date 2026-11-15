// Saved runs (ARCHITECTURE.md §9.2). A run holds the answers for one questionnaire, plus what
// Alex approved or changed. Runs live in IndexedDB and are mirrored here for the screens.
import { clear, createStore, del, entries, set as idbSet } from "idb-keyval";
import { create } from "zustand";
import type { ModelKey, TaskKey } from "../config/models";
import type { TaskUsage } from "../llm/client";
import type { FoundByEntry } from "../pipeline/candidates";
import type { Obligation } from "../pipeline/findObligations";
import type { ParentResult } from "../types";

export type Run = {
  id: string;
  /** A whole questionnaire, or the obligations of one Policy Guide section. */
  kind: "questionnaire" | "section";
  /** The questionnaire's ID, or the Guide's. */
  sourceId: string;
  /** For a section check: the section and the obligations that were checked, as they were then. */
  section?: { id: string; title: string; path: string[]; pageStart: number; obligations: Obligation[] };
  title: string;
  /** Came with the site as a demo file, not from a run in this browser. */
  demo?: boolean;
  createdAt: number;
  updatedAt: number;
  /** "paused": stopped before every answer was ready (cancelled, tab closed, key or network problem). */
  status: "running" | "paused" | "done";
  models: { fullReading: ModelKey; secondOpinion: ModelKey };
  questionCount: number;
  checkCount: number | null;
  policiesRead: number;
  cost: number;
  /** Time spent running, added up over every session of this run. Absent on runs saved before this was recorded. */
  activeMs?: number;
  usageByTask: Partial<Record<TaskKey, TaskUsage>>;
  results: ParentResult[];
  /** Which search layer pointed to which policy for which check. Recorded when a run finishes, for the accuracy page. */
  foundBy?: FoundByEntry[];
};

const db = createStore("readily-runs", "runs");

type RunsState = {
  runs: Record<string, Run>;
  loaded: boolean;
  load(): Promise<void>;
  put(run: Run): void;
  patchResult(runId: string, parentId: string, patch: Partial<Pick<ParentResult, "approved" | "edited" | "followUp">>): void;
  clearAll(): Promise<void>;
  remove(runId: string): void;
  /** Adds runs from a demo file, unless this browser already has its own copy. Not written to disk until changed. */
  addDemo(runs: Run[]): void;
};

const persist = (run: Run) => void idbSet(run.id, run, db).catch((err) => console.error("Could not save the run", err));

export const useRuns = create<RunsState>((set, get) => ({
  runs: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const runs: Record<string, Run> = {};
    try {
      for (const [, run] of await entries<string, Run>(db)) {
        // a run that was "running" when the tab closed is now paused; finished calls are saved
        runs[run.id] = run.status === "running" ? { ...run, status: "paused" } : run;
      }
    } catch (err) {
      console.error("Could not read saved runs", err);
    }
    set({ runs: { ...runs, ...get().runs }, loaded: true });
  },
  put: (run) => {
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
    persist(run);
  },
  patchResult: (runId, parentId, patch) => {
    const run = get().runs[runId];
    if (!run) return;
    const results = run.results.map((r) => {
      if (r.parentId !== parentId) return r;
      const next = { ...r, ...patch };
      if ("edited" in patch && patch.edited === undefined) delete next.edited;
      if ("followUp" in patch && patch.followUp === undefined) delete next.followUp;
      return next;
    });
    get().put({ ...run, results, updatedAt: Date.now() });
  },
  clearAll: async () => {
    await clear(db);
    set({ runs: {} });
  },
  addDemo: (demo) =>
    set((s) => {
      const runs = { ...s.runs };
      for (const r of demo) if (!runs[r.id]) runs[r.id] = { ...r, demo: true, status: r.status === "running" ? "paused" : r.status };
      return { runs };
    }),
  remove: (runId) => {
    set((s) => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest };
    });
    void del(runId, db);
  },
}));

/** The answer and citation that would go on the form: Alex's edit if there is one, else the suggestion. */
export function currentAnswer(r: ParentResult): { answer: "yes" | "no" | null; citation: string } {
  return r.edited ?? { answer: r.suggestedAnswer, citation: r.suggestedCitation };
}

/** Policies an answer rests on that may be out of date, with how many answers cite each. */
export function outdatedPolicies(run: Run): { policyId: string; answers: number; notes: string[] }[] {
  const byPolicy = new Map<string, { answers: Set<string>; notes: Set<string> }>();
  for (const r of run.results) {
    for (const i of r.items) {
      if (i.status === "not_covered") continue;
      for (const f of i.flags) {
        if (f.code !== "policy_predates_apl" && f.code !== "cites_superseded_apl") continue;
        const policyId = f.detail.split(" ")[0];
        let p = byPolicy.get(policyId);
        if (!p) byPolicy.set(policyId, (p = { answers: new Set(), notes: new Set() }));
        p.answers.add(r.parentId);
        p.notes.add(f.detail.slice(policyId.length + 1));
      }
    }
  }
  return [...byPolicy].map(([policyId, p]) => ({ policyId, answers: p.answers.size, notes: [...p.notes] })).sort((a, b) => b.answers - a.answers || a.policyId.localeCompare(b.policyId));
}

/** Checks that could not be analysed and can be retried. */
export const failedCount = (run: Run) => run.results.filter((r) => r.items.some((i) => i.flags.some((f) => f.code === "analysis_failed"))).length;
