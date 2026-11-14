// What has been done on each Policy Guide section: the obligations found in it, which of them
// are ticked for checking, and the latest check (ARCHITECTURE.md §9.2). Kept in IndexedDB.
import { clear, createStore, entries, set as idbSet } from "idb-keyval";
import { create } from "zustand";
import { createLLM, LLMError, UsageTracker, type CallStore } from "../llm/client";
import { idbCallStore } from "../llm/cache";
import { findObligations, type SectionObligations } from "../pipeline/findObligations";
import type { GuideSection } from "../types";
import { useSettings } from "./settings";

export type SectionWork = {
  guideId: string;
  sectionId: string;
  found: SectionObligations;
  foundAt: number;
  /** Obligations Alex chose not to check. */
  unticked: string[];
  /** The latest check of this section, if any. */
  runId: string | null;
};

const db = createStore("readily-guides", "sections");
const keyOf = (guideId: string, sectionId: string) => `${guideId}/${sectionId}`;

type GuidesState = {
  work: Record<string, SectionWork>;
  loaded: boolean;
  /** The section whose obligations are being found right now. */
  finding: string | null;
  problem: { key: string; message: string } | null;
  load(): Promise<void>;
  get(guideId: string, sectionId: string): SectionWork | undefined;
  /** Step 22. `again` ignores the saved answer and asks afresh. */
  find(guideId: string, section: GuideSection, again?: boolean): Promise<void>;
  setTicked(guideId: string, sectionId: string, obligationId: string, ticked: boolean): void;
  setRun(guideId: string, sectionId: string, runId: string | null): void;
  clearAll(): Promise<void>;
};

export const useGuides = create<GuidesState>((set, get) => {
  const put = (w: SectionWork) => {
    const key = keyOf(w.guideId, w.sectionId);
    set((s) => ({ work: { ...s.work, [key]: w } }));
    void idbSet(key, w, db).catch((err) => console.error("Could not save the section", err));
  };
  return {
    work: {},
    loaded: false,
    finding: null,
    problem: null,
    load: async () => {
      if (get().loaded) return;
      const work: Record<string, SectionWork> = {};
      try {
        for (const [key, w] of await entries<string, SectionWork>(db)) work[key] = w;
      } catch (err) {
        console.error("Could not read saved Guide work", err);
      }
      set({ work: { ...work, ...get().work }, loaded: true });
    },
    get: (guideId, sectionId) => get().work[keyOf(guideId, sectionId)],
    find: async (guideId, section, again = false) => {
      const key = keyOf(guideId, section.id);
      if (get().finding) return;
      set({ finding: key, problem: null });
      try {
        const saved = idbCallStore();
        // asking again must not be answered from the saved call, but its answer is saved for next time
        const store: CallStore = again ? { ...saved, get: async () => undefined } : saved;
        const llm = createLLM({ apiKey: () => useSettings.getState().apiKey, store, browser: true });
        const found = await findObligations({ section, llm, tracker: new UsageTracker() });
        put({ guideId, sectionId: section.id, found, foundAt: Date.now(), unticked: [], runId: null });
      } catch (err) {
        const e = err instanceof LLMError ? err : null;
        if (!e) console.error(err);
        const message =
          e?.kind === "no_key" ? "Add your API key in Settings first." : e?.kind === "auth" ? "The API key was not accepted. Check it in Settings." : e?.kind === "billing" ? "The API account has no credit left." : "The section could not be read just now. Try again in a moment.";
        set({ problem: { key, message } });
      } finally {
        set({ finding: null });
      }
    },
    setTicked: (guideId, sectionId, obligationId, ticked) => {
      const w = get().get(guideId, sectionId);
      if (!w) return;
      const unticked = w.unticked.filter((id) => id !== obligationId);
      if (!ticked) unticked.push(obligationId);
      put({ ...w, unticked });
    },
    setRun: (guideId, sectionId, runId) => {
      const w = get().get(guideId, sectionId);
      if (w) put({ ...w, runId });
    },
    clearAll: async () => {
      await clear(db);
      set({ work: {} });
    },
  };
});
