// The two accuracy switches in the header (ARCHITECTURE.md §6, §10.2). They apply to the next
// run that is started and go back to the defaults in config/models.ts when the page reloads.
import { create } from "zustand";
import { TASKS, type ModelKey } from "../config/models";

export type AccuracyChoice = { fullReading: ModelKey; secondOpinion: ModelKey };

type AccuracyState = AccuracyChoice & { set(step: keyof AccuracyChoice, model: ModelKey): void };

export const useAccuracy = create<AccuracyState>((set) => ({
  fullReading: TASKS.fullReading.model,
  secondOpinion: TASKS.secondOpinion.model,
  set: (step, model) => set({ [step]: model } as Partial<AccuracyChoice>),
}));

export const currentAccuracy = (): AccuracyChoice => {
  const { fullReading, secondOpinion } = useAccuracy.getState();
  return { fullReading, secondOpinion };
};
