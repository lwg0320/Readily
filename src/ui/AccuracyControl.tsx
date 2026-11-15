// The two accuracy switches in the header (ARCHITECTURE.md §10.2).
import { MODELS, type ModelKey } from "../config/models";
import { useAccuracy, type AccuracyChoice } from "../store/accuracy";
import { useRunner } from "../store/runner";
import { InfoTip } from "./bits";

const STEPS: { step: keyof AccuracyChoice; name: string }[] = [
  { step: "fullReading", name: "Full reading" },
  { step: "secondOpinion", name: "Second opinion" },
];
const CHOICES: { model: ModelKey; word: string }[] = [
  { model: "haiku", word: "Standard" },
  { model: "opus", word: "Maximum" },
];

export function AccuracyControl() {
  const accuracy = useAccuracy();
  const running = useRunner((s) => !!s.active);
  return (
    <div className="flex items-center gap-3 text-[13px]" role="group" aria-label="Accuracy for the next run">
      {STEPS.map(({ step, name }) => (
        <div key={step} className="flex items-center gap-1.5">
          <span className="text-ink-soft">{name}</span>
          <div className="flex overflow-hidden rounded border border-rule" role="radiogroup" aria-label={`${name} accuracy`}>
            {CHOICES.map(({ model, word }) => {
              const on = accuracy[step] === model;
              return (
                <button
                  key={model}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={running}
                  title={running ? "The switches are locked while a run is in progress" : `${MODELS[model].label} (${MODELS[model].short})`}
                  onClick={() => accuracy.set(step, model)}
                  className={`px-2 py-1 font-semibold disabled:cursor-not-allowed ${on ? (model === "opus" ? "bg-stamp text-white" : "bg-ink text-white") : "bg-paper text-ink-soft hover:text-ink disabled:opacity-50"}`}
                >
                  {word}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <InfoTip label="What the accuracy switches do">
        <div className="space-y-2.5 text-ink-soft">
          <p>
            <span className="font-semibold text-ink">Full reading</span> is the step that reads the policies that matter from start to finish and quotes them. <span className="font-semibold text-ink">Second opinion</span> is the independent check of every answer, including the third reading that settles a disagreement.
          </p>
          <p>
            <span className="font-semibold text-ink">Standard</span> uses a fast model: about $2.30 for a 64-question questionnaire. <span className="font-semibold text-ink">Maximum</span> uses the most capable model for that step. It is slower and costs roughly 30 times more for that step, about $50 with both switched on.
          </p>
          <p>The first pass, in which every policy is read against every check, always uses the fast model.</p>
          <p>The switches apply to the next run you start, and its price is shown before you start it. Work that is already saved is not paid for again. They are locked while a run is in progress and go back to Standard when the page is reloaded.</p>
          {accuracy.fullReading !== accuracy.secondOpinion && <p className="font-semibold text-review">The two steps are set differently, so the policies are loaded once for each model. The extra cost is included in the estimate.</p>}
        </div>
      </InfoTip>
    </div>
  );
}
