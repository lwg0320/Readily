// Demo files (ARCHITECTURE.md §9.3): saved work exported from one browser and shipped with the
// site, so that a visitor without an API key can open full results and try the review screens.
import { useGuides, type SectionWork } from "./guides";
import { useRuns, type Run } from "./runs";

export type DemoFile = { readilyDemo: 1; exportedAt: number; runs: Run[]; guideWork: SectionWork[] };

/** Everything saved in this browser, as one file. It holds answers and quotes, never the API key. */
export function exportDemo(): DemoFile {
  const runs = Object.values(useRuns.getState().runs)
    .filter((r) => r.results.length > 0)
    .map((r) => ({ ...r, status: r.status === "running" ? ("paused" as const) : r.status }));
  const kept = new Set(runs.map((r) => r.id));
  const guideWork = Object.values(useGuides.getState().work).map((w) => ({ ...w, runId: w.runId && kept.has(w.runId) ? w.runId : null }));
  return { readilyDemo: 1, exportedAt: Date.now(), runs, guideWork };
}

/**
 * Loads the demo files listed in public/demo/index.json. What is already in this browser wins,
 * so a visitor's own approvals on a demo run are kept from one visit to the next.
 */
export async function loadDemos(): Promise<void> {
  const base = `${import.meta.env.BASE_URL}demo/`;
  try {
    const index = await fetch(`${base}index.json`, { cache: "no-cache" });
    if (!index.ok) return;
    const names: unknown = await index.json();
    if (!Array.isArray(names)) return;
    for (const name of names) {
      if (typeof name !== "string") continue;
      const res = await fetch(base + name, { cache: "no-cache" });
      if (!res.ok) continue;
      const file = (await res.json()) as Partial<DemoFile>;
      if (file.readilyDemo !== 1) continue;
      useRuns.getState().addDemo(file.runs ?? []);
      useGuides.getState().addDemo(file.guideWork ?? []);
    }
  } catch (err) {
    console.warn("No demo files were loaded", err);
  }
}
