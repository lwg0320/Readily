// Loading the prepared data (public/data) in the browser.
// The small catalogue loads at start. The full text of the Medi-Cal policies and the search
// index (about 28 MB) load only when a run starts: looking at saved answers does not need them.
import { create } from "zustand";
import { createLibrary, type Library } from "../pipeline/library";
import type { Apl, Policy, Questionnaire } from "../types";

export type PolicyMeta = Pick<Policy, "id" | "title" | "revisedDate" | "programs" | "pageCount">;

export type Catalog = {
  planName: string;
  counts: { policies: number; mediCalPolicies: number; pages: number };
  policies: PolicyMeta[];
  apls: { id: string; number: string; subject: string; date: string | null; pageCount: number }[];
  questionnaires: { id: string; title: string; aplId: string; aplNumber: string; subject: string; questionCount: number; hasFormMap: boolean }[];
};

const BASE = import.meta.env.BASE_URL;
export const dataUrl = (path: string) => `${BASE}data/${path}`;
export const pdfUrl = (kind: "policies" | "apl" | "questionnaires", id: string) => `${BASE}pdfs/${kind}/${id}.pdf`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

type CatalogState = { catalog: Catalog | null; error: string | null; load(): Promise<void> };

export const useCatalog = create<CatalogState>((set, get) => ({
  catalog: null,
  error: null,
  load: async () => {
    if (get().catalog) return;
    try {
      set({ catalog: await getJson<Catalog>("library.json"), error: null });
    } catch (err) {
      set({ error: "The prepared library could not be loaded. Run “npm run prep”, then reload." });
      console.error(err);
    }
  },
}));

const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
  let p = cache.get(key);
  if (!p) {
    p = load().catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, p);
  }
  return p;
};

const questionnaires = new Map<string, Promise<Questionnaire>>();
const apls = new Map<string, Promise<Apl>>();
export const loadQuestionnaire = (id: string) => once(questionnaires, id, () => getJson<Questionnaire>(`questionnaires/${id}.json`));
export const loadApl = (id: string) => once(apls, id, () => getJson<Apl>(`apl/${id}.json`));

let library: Promise<Library> | null = null;

/** The full Medi-Cal library, loaded once. `onProgress` counts policies as they arrive. */
export function loadLibrary(catalog: Catalog, onProgress: (done: number, total: number) => void): Promise<Library> {
  if (library) return library;
  const wanted = catalog.policies.filter((p) => p.programs.mediCal);
  const load = async (): Promise<Library> => {
    let done = 0;
    onProgress(0, wanted.length);
    const policies: Policy[] = new Array(wanted.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < wanted.length; i = next++) {
        policies[i] = await getJson<Policy>(`policies/${wanted[i].id}.json`);
        onProgress(++done, wanted.length);
      }
    };
    const index = fetch(dataUrl("search-index.json")).then((r) => {
      if (!r.ok) throw new Error(`Could not load the search index (${r.status})`);
      return r.text();
    });
    await Promise.all(Array.from({ length: 12 }, worker));
    return createLibrary(policies, await index);
  };
  library = load().catch((err) => {
    library = null;
    throw err;
  });
  return library;
}
