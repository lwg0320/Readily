// The API key lives only in this browser's localStorage (ARCHITECTURE.md §9.2).
import { create } from "zustand";

const KEY = "readily.apiKey";
const read = (): string | null => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

type Settings = {
  apiKey: string | null;
  setApiKey(key: string | null): void;
  settingsOpen: boolean;
  openSettings(open: boolean): void;
};

export const useSettings = create<Settings>((set) => ({
  apiKey: read(),
  setApiKey: (key) => {
    const clean = key?.trim() || null;
    try {
      if (clean) localStorage.setItem(KEY, clean);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: the key then lasts for this tab only */
    }
    set({ apiKey: clean });
  },
  settingsOpen: false,
  openSettings: (settingsOpen) => set({ settingsOpen }),
}));
