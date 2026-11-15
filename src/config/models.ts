// THE model settings file (ARCHITECTURE.md §6). This is the only place a model is named.

export type ModelKey = "haiku" | "opus";
export type Effort = "low" | "medium" | "high";

export const MODELS: Record<
  ModelKey,
  { id: string; label: string; short: string; price: { input: number; output: number; cacheWrite: number; cacheRead: number } }
> = {
  // prices in $ per million tokens (Haiku: prompts up to 100k tokens)
  haiku: { id: "claude-haiku-5-5", label: "Standard", short: "Haiku", price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } },
  opus: { id: "claude-opus-5-5", label: "Maximum accuracy", short: "Opus", price: { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 } },
};

export type TaskKey = "checklist" | "readEveryPolicy" | "fullReading" | "secondOpinion" | "findObligations" | "baseline";

// Thinking counts toward maxTokens on these models, so the limits are generous. You only pay
// for tokens actually produced.
export const TASKS: Record<TaskKey, { model: ModelKey; effort: Effort; maxTokens: number; uiToggle: boolean }> = {
  checklist: { model: "haiku", effort: "high", maxTokens: 8000, uiToggle: false }, // Step 7
  readEveryPolicy: { model: "haiku", effort: "low", maxTokens: 4000, uiToggle: false }, // Step 9
  fullReading: { model: "haiku", effort: "high", maxTokens: 16000, uiToggle: true }, // Step 11
  secondOpinion: { model: "haiku", effort: "high", maxTokens: 20000, uiToggle: true }, // Step 13, including its tie-break
  findObligations: { model: "haiku", effort: "high", maxTokens: 10000, uiToggle: false }, // Step 22
  baseline: { model: "haiku", effort: "high", maxTokens: 6000, uiToggle: false }, // accuracy page only: the naive one-prompt comparison
};
