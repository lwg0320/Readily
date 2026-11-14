// Runs the questionnaire pipeline in the browser and keeps the screens informed.
// One run at a time. Every finished API call is saved, so a stopped run resumes for free.
import { create } from "zustand";
import { TASKS, type TaskKey } from "../config/models";
import { createLLM, LLMError, UsageTracker, type LLMErrorKind, type TaskUsage } from "../llm/client";
import { idbCallStore } from "../llm/cache";
import { runQuestionnaire } from "../pipeline/runQuestionnaire";
import type { ParentResult } from "../types";
import { loadApl, loadLibrary, loadQuestionnaire, useCatalog } from "./catalog";
import { useRuns, type Run } from "./runs";
import { useSettings } from "./settings";

type Count = { done: number; total: number };

export type ActiveRun = {
  runId: string;
  sourceId: string;
  stage: "library" | "checklist" | "screening" | "reading";
  library: Count;
  checklist: Count;
  checks: number | null;
  screening: Count;
  groups: Count;
  /** Full readings, second opinions and tie-breaks finished so far: shows the last stage is alive. */
  readings: number;
  /** The API asked us to slow down. */
  slow: boolean;
};

export type RunProblem = { sourceId: string; kind: LLMErrorKind | "other"; message: string };

type RunnerState = {
  active: ActiveRun | null;
  problem: RunProblem | null;
  /** Starts a new run, or continues `resumeRunId`. Returns the run's ID. */
  start(questionnaireId: string, resumeRunId?: string): string | null;
  cancel(): void;
  dismissProblem(): void;
};

let abort: AbortController | null = null;

const mergeUsage = (a: Run["usageByTask"], b: Run["usageByTask"]): Run["usageByTask"] => {
  const out: Run["usageByTask"] = { ...a };
  for (const [task, u] of Object.entries(b) as [TaskKey, TaskUsage][]) {
    const base = out[task];
    out[task] = base
      ? { calls: base.calls + u.calls, savedCalls: base.savedCalls + u.savedCalls, input: base.input + u.input, cacheWrite: base.cacheWrite + u.cacheWrite, cacheRead: base.cacheRead + u.cacheRead, output: base.output + u.output, cost: base.cost + u.cost, cutOff: base.cutOff + u.cutOff }
      : { ...u };
  }
  return out;
};

/** Fresh results replace older ones for the same question; what Alex approved or edited is kept. */
function mergeResults(existing: ParentResult[], fresh: ParentResult[]): ParentResult[] {
  const out = [...existing];
  for (const r of fresh) {
    const i = out.findIndex((x) => x.parentId === r.parentId);
    if (i < 0) out.push(r);
    else out[i] = { ...r, approved: out[i].approved, ...(out[i].edited ? { edited: out[i].edited } : {}), ...(out[i].followUp !== undefined ? { followUp: out[i].followUp } : {}) };
  }
  return out;
}

const PLAIN: Partial<Record<LLMErrorKind, string>> = {
  no_key: "Add your API key in Settings to run live.",
  auth: "The API key was not accepted. Check it in Settings.",
  billing: "The API account has no credit left. Add credit, then resume: finished work is saved.",
  overloaded: "The API is not responding right now. Resume in a few minutes: finished work is saved.",
};

export const useRunner = create<RunnerState>((set, get) => ({
  active: null,
  problem: null,
  dismissProblem: () => set({ problem: null }),
  cancel: () => abort?.abort(),

  start: (questionnaireId, resumeRunId) => {
    if (get().active) return get().active!.runId;
    const catalog = useCatalog.getState().catalog;
    const meta = catalog?.questionnaires.find((q) => q.id === questionnaireId);
    if (!catalog || !meta) return null;

    const runs = useRuns.getState();
    const previous = resumeRunId ? runs.runs[resumeRunId] : undefined;
    const now = Date.now();
    const base: Run = previous
      ? { ...previous, status: "running", updatedAt: now }
      : {
          id: `run-${now.toString(36)}`,
          kind: "questionnaire",
          sourceId: questionnaireId,
          title: `APL ${meta.aplNumber}: ${meta.subject}`,
          createdAt: now,
          updatedAt: now,
          status: "running",
          models: { fullReading: TASKS.fullReading.model, secondOpinion: TASKS.secondOpinion.model },
          questionCount: meta.questionCount,
          checkCount: null,
          policiesRead: catalog.counts.mediCalPolicies,
          cost: 0,
          usageByTask: {},
          results: [],
        };
    runs.put(base);

    const patchActive = (patch: Partial<ActiveRun>) => set((s) => (s.active ? { active: { ...s.active, ...patch } } : s));
    const zero = { done: 0, total: 0 };
    set({ problem: null, active: { runId: base.id, sourceId: questionnaireId, stage: "library", library: zero, checklist: zero, checks: base.checkCount, screening: zero, groups: zero, readings: 0, slow: false } });

    const controller = new AbortController();
    abort = controller;
    const tracker = new UsageTracker();
    const current = () => useRuns.getState().runs[base.id] ?? base;
    // what this session has spent is added to what earlier sessions of the same run spent
    const save = (patch: Partial<Run>) =>
      useRuns.getState().put({ ...current(), ...patch, cost: base.cost + tracker.totalCost, usageByTask: mergeUsage(base.usageByTask, tracker.byTask), updatedAt: Date.now() });

    let lastCostSave = 0;
    let lastThrottle = 0;
    tracker.onChange(() => {
      const n = (task: TaskKey) => (tracker.byTask[task]?.calls ?? 0) + (tracker.byTask[task]?.savedCalls ?? 0);
      const readings = n("fullReading") + n("secondOpinion");
      if (readings !== get().active?.readings) patchActive({ readings, slow: Date.now() - lastThrottle < 30_000 });
      // keep the running cost on screen without writing to disk on every call
      if (Date.now() - lastCostSave > 1500) {
        lastCostSave = Date.now();
        save({});
      }
    });

    void (async () => {
      try {
        const [questionnaire, library] = await Promise.all([
          loadQuestionnaire(questionnaireId),
          loadLibrary(catalog, (done, total) => patchActive({ library: { done, total } })),
        ]);
        const apl = await loadApl(questionnaire.aplId);
        if (controller.signal.aborted) throw new LLMError("aborted", "Cancelled.");
        patchActive({ stage: "checklist", checklist: { done: 0, total: questionnaire.questions.length } });

        const llm = createLLM({
          apiKey: () => useSettings.getState().apiKey,
          store: idbCallStore(),
          browser: true,
          onThrottle: () => {
            lastThrottle = Date.now();
            patchActive({ slow: true });
          },
        });
        await runQuestionnaire({
          questions: questionnaire.questions,
          apl,
          library,
          llm,
          models: base.models,
          tracker,
          signal: controller.signal,
          onProgress: (e) => {
            if (e.stage === "checklist") patchActive({ stage: "checklist", checklist: { done: e.done, total: e.total } });
            if (e.stage === "screening") patchActive({ stage: "screening", screening: { done: e.done, total: e.total } });
            if (e.stage === "reading") patchActive({ stage: "reading", groups: { done: e.done, total: e.total } });
          },
          onChecklists: (lists) => {
            const checks = lists.reduce((n, c) => n + c.items.length, 0);
            patchActive({ checks, checklist: { done: lists.length, total: lists.length } });
            save({ checkCount: checks });
          },
          onGroupDone: (results) => save({ results: mergeResults(current().results, results) }),
        });
        save({ status: "done" });
      } catch (err) {
        // a new run that stopped before producing or costing anything leaves nothing behind
        if (!previous && current().results.length === 0 && tracker.totalCost === 0) useRuns.getState().remove(base.id);
        else save({ status: "paused" });
        const e = err instanceof LLMError ? err : null;
        if (!e) console.error(err);
        if (e?.kind !== "aborted") {
          set({ problem: { sourceId: questionnaireId, kind: e?.kind ?? "other", message: (e && PLAIN[e.kind]) ?? "The run stopped unexpectedly. Finished work is saved: run again to continue." } });
        }
      } finally {
        if (abort === controller) abort = null;
        set({ active: null });
      }
    })();

    return base.id;
  },
}));
