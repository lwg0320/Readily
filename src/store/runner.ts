// Runs the questionnaire pipeline in the browser and keeps the screens informed.
// One run at a time. Every finished API call is saved, so a stopped run resumes for free.
import { create } from "zustand";
import type { TaskKey } from "../config/models";
import { createLLM, LLMError, UsageTracker, type LLMErrorKind, type TaskUsage } from "../llm/client";
import { idbCallStore } from "../llm/cache";
import type { Library } from "../pipeline/library";
import type { OnProgress } from "../pipeline/progress";
import { runQuestionnaire } from "../pipeline/runQuestionnaire";
import { runSectionCheck } from "../pipeline/runSectionCheck";
import type { LLM } from "../llm/client";
import type { ParentResult } from "../types";
import { currentAccuracy } from "./accuracy";
import { loadApl, loadGuide, loadLibrary, loadQuestionnaire, useCatalog, type Catalog } from "./catalog";
import { useGuides } from "./guides";
import { useRuns, type Run } from "./runs";
import { useSettings } from "./settings";

type Count = { done: number; total: number };

export type ActiveRun = {
  runId: string;
  kind: Run["kind"];
  sourceId: string;
  /** For a section check. */
  sectionId?: string;
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

export type RunProblem = { sourceId: string; sectionId?: string; kind: LLMErrorKind | "other"; message: string };

type RunnerState = {
  active: ActiveRun | null;
  problem: RunProblem | null;
  /** Starts a questionnaire run, or continues `resumeRunId`. Returns the run's ID. */
  start(questionnaireId: string, resumeRunId?: string): string | null;
  /** Checks the ticked obligations of one Guide section (Step 24), or continues `resumeRunId`. */
  startSection(guideId: string, sectionId: string, resumeRunId?: string): string | null;
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

type Work = { library: Library; llm: LLM; tracker: UsageTracker; signal: AbortSignal; onProgress: OnProgress; patchActive: (patch: Partial<ActiveRun>) => void; save: (patch: Partial<Run>) => void; current: () => Run };

export const useRunner = create<RunnerState>((set, get) => {
  /** Everything a run of either kind shares: progress, cost, saving, pausing and plain error messages. */
  function launch(catalog: Catalog, base: Run, isNew: boolean, work: (w: Work) => Promise<void>, onDiscard?: () => void) {
    const runs = useRuns.getState();
    runs.put(base);
    const patchActive = (patch: Partial<ActiveRun>) => set((s) => (s.active ? { active: { ...s.active, ...patch } } : s));
    const zero = { done: 0, total: 0 };
    set({ problem: null, active: { runId: base.id, kind: base.kind, sourceId: base.sourceId, sectionId: base.section?.id, stage: "library", library: zero, checklist: zero, checks: base.checkCount, screening: zero, groups: zero, readings: 0, slow: false } });

    const controller = new AbortController();
    abort = controller;
    const tracker = new UsageTracker();
    const current = () => useRuns.getState().runs[base.id] ?? base;
    const startedAt = Date.now();
    // what this session has spent is added to what earlier sessions of the same run spent
    const save = (patch: Partial<Run>) =>
      useRuns.getState().put({ ...current(), ...patch, cost: base.cost + tracker.totalCost, activeMs: (base.activeMs ?? 0) + (Date.now() - startedAt), usageByTask: mergeUsage(base.usageByTask, tracker.byTask), updatedAt: Date.now() });

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
        const library = await loadLibrary(catalog, (done, total) => patchActive({ library: { done, total } }));
        if (controller.signal.aborted) throw new LLMError("aborted", "Cancelled.");
        const llm = createLLM({
          apiKey: () => useSettings.getState().apiKey,
          store: idbCallStore(),
          browser: true,
          onThrottle: () => {
            lastThrottle = Date.now();
            patchActive({ slow: true });
          },
        });
        const onProgress: OnProgress = (e) => {
          if (e.stage === "checklist") patchActive({ stage: "checklist", checklist: { done: e.done, total: e.total } });
          if (e.stage === "screening") patchActive({ stage: "screening", screening: { done: e.done, total: e.total } });
          if (e.stage === "reading") patchActive({ stage: "reading", groups: { done: e.done, total: e.total } });
        };
        await work({ library, llm, tracker, signal: controller.signal, onProgress, patchActive, save, current });
        save({ status: "done" });
      } catch (err) {
        // a new run that stopped before producing or costing anything leaves nothing behind
        if (isNew && current().results.length === 0 && tracker.totalCost === 0) {
          useRuns.getState().remove(base.id);
          onDiscard?.();
        } else save({ status: "paused" });
        const e = err instanceof LLMError ? err : null;
        if (!e) console.error(err);
        if (e?.kind !== "aborted") {
          set({ problem: { sourceId: base.sourceId, sectionId: base.section?.id, kind: e?.kind ?? "other", message: (e && PLAIN[e.kind]) ?? "The run stopped unexpectedly. Finished work is saved: run again to continue." } });
        }
      } finally {
        if (abort === controller) abort = null;
        set({ active: null });
      }
    })();
    return base.id;
  }

  const blank = (now: number) => ({
    createdAt: now,
    updatedAt: now,
    status: "running" as const,
    // a new run uses the accuracy switches as they stand now; a resumed run keeps its own
    models: currentAccuracy(),
    cost: 0,
    usageByTask: {},
    results: [],
  });

  return {
    active: null,
    problem: null,
    dismissProblem: () => set({ problem: null }),
    cancel: () => abort?.abort(),

    start: (questionnaireId, resumeRunId) => {
      if (get().active) return get().active!.runId;
      const catalog = useCatalog.getState().catalog;
      const meta = catalog?.questionnaires.find((q) => q.id === questionnaireId);
      if (!catalog || !meta) return null;
      const previous = resumeRunId ? useRuns.getState().runs[resumeRunId] : undefined;
      const now = Date.now();
      const base: Run = previous
        ? { ...previous, demo: undefined, status: "running", updatedAt: now }
        : { ...blank(now), id: `run-${now.toString(36)}`, kind: "questionnaire", sourceId: questionnaireId, title: `APL ${meta.aplNumber}: ${meta.subject}`, questionCount: meta.questionCount, checkCount: null, policiesRead: catalog.counts.mediCalPolicies };

      return launch(catalog, base, !previous, async ({ library, llm, tracker, signal, onProgress, patchActive, save, current }) => {
        const questionnaire = await loadQuestionnaire(questionnaireId);
        const apl = await loadApl(questionnaire.aplId);
        patchActive({ stage: "checklist", checklist: { done: 0, total: questionnaire.questions.length } });
        const finished = await runQuestionnaire({
          questions: questionnaire.questions,
          apl,
          library,
          llm,
          models: base.models,
          tracker,
          signal,
          onProgress,
          onChecklists: (lists) => {
            const checks = lists.reduce((n, c) => n + c.items.length, 0);
            patchActive({ checks, checklist: { done: lists.length, total: lists.length } });
            save({ checkCount: checks });
          },
          onGroupDone: (results) => save({ results: mergeResults(current().results, results) }),
        });
        save({ foundBy: finished.foundBy });
      });
    },

    startSection: (guideId, sectionId, resumeRunId) => {
      if (get().active) return get().active!.runId;
      const catalog = useCatalog.getState().catalog;
      const meta = catalog?.guides.find((g) => g.id === guideId);
      const sectionWork = useGuides.getState().get(guideId, sectionId);
      if (!catalog || !meta || !sectionWork) return null;
      const previous = resumeRunId ? useRuns.getState().runs[resumeRunId] : undefined;
      const obligations = previous?.section?.obligations ?? sectionWork.found.obligations.filter((o) => !sectionWork.unticked.includes(o.id));
      if (!obligations.length) return null;
      const now = Date.now();
      const base: Run = previous
        ? { ...previous, status: "running", updatedAt: now }
        : {
            ...blank(now),
            id: `run-${now.toString(36)}`,
            kind: "section",
            sourceId: guideId,
            // title, path and page are filled in from the Guide as soon as it is loaded, below
            section: { id: sectionId, title: "", path: [], pageStart: 0, obligations },
            title: meta.title,
            questionCount: 1,
            checkCount: obligations.length,
            policiesRead: catalog.counts.mediCalPolicies,
          };
      const earlierCheck = sectionWork.runId;
      useGuides.getState().setRun(guideId, sectionId, base.id);

      return launch(
        catalog,
        base,
        !previous,
        async ({ library, llm, tracker, signal, onProgress, save }) => {
          const guide = await loadGuide(guideId);
          const section = guide.sections.find((s) => s.id === sectionId);
          if (!section) throw new Error(`Section ${sectionId} is not in ${guideId}`);
          save({ section: { id: section.id, title: section.title, path: section.path, pageStart: section.pageStart, obligations } });
          await runSectionCheck({ guide, section, obligations, library, llm, models: base.models, tracker, signal, onProgress, onGroupDone: (results) => save({ results }) });
        },
        // a check that never got going must not hide the one before it
        () => useGuides.getState().setRun(guideId, sectionId, earlierCheck),
      );
    },
  };
});
