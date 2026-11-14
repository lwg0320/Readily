// How a saved run is described in lists.
import { MODELS } from "../config/models";
import { formatCost } from "../pipeline/estimate";
import type { Run } from "../store/runs";
import type { Verdict } from "../types";
import { VerdictChip } from "./bits";
import { VERDICT_ORDER } from "./labels";

export const verdictCounts = (run: Run) => {
  const counts = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const r of run.results) counts[r.verdict]++;
  return counts;
};

export function VerdictCounts({ run }: { run: Run }) {
  const counts = verdictCounts(run);
  return (
    <span className="flex flex-wrap gap-1.5">
      {VERDICT_ORDER.filter((v) => counts[v] > 0).map((v) => (
        <VerdictChip key={v} verdict={v} count={counts[v]} size="sm" />
      ))}
    </span>
  );
}

export const accuracyText = (run: Pick<Run, "models">) => {
  const { fullReading, secondOpinion } = run.models;
  return fullReading === secondOpinion ? `${MODELS[fullReading].label} accuracy` : `${MODELS[fullReading].label} reading, ${MODELS[secondOpinion].label.toLowerCase()} second opinion`;
};

export const costText = (run: Run) => {
  const cost = run.cost > 0 ? `${formatCost(run.cost)} spent` : "no cost";
  const minutes = run.activeMs ? Math.max(1, Math.round(run.activeMs / 60_000)) : 0;
  return minutes ? `${cost}, ${minutes} ${minutes === 1 ? "minute" : "minutes"} of running` : cost;
};
