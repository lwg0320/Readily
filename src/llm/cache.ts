// Saved-call store in the browser (IndexedDB). Every finished API call is kept here, keyed by
// its full request, so repeating a step costs nothing and a run can resume after a refresh.
import { clear, createStore, get, set } from "idb-keyval";
import type { CallStore, SavedCall } from "./client";

export function idbCallStore(): CallStore {
  const store = createStore("readily-saved-calls", "calls");
  return {
    get: (key) => get<SavedCall>(key, store),
    set: (key, value) => set(key, value, store),
    clear: () => clear(store),
  };
}
