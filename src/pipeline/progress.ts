export type Stage = "checklist" | "screening" | "reading" | "done";

export type ProgressEvent =
  | { stage: "checklist"; done: number; total: number }
  | { stage: "screening"; done: number; total: number }
  | { stage: "reading"; done: number; total: number } // groups finished
  | { stage: "throttled"; waitMs: number }
  | { stage: "done" };

export type OnProgress = (e: ProgressEvent) => void;
