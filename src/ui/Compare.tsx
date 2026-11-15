// The questions two runs of the same questionnaire answer differently (ARCHITECTURE.md §10.3).
import { Link, useNavigate, useParams } from "react-router-dom";
import { differences } from "../pipeline/compare";
import { loadQuestionnaire } from "../store/catalog";
import { useRuns, type Run } from "../store/runs";
import type { ParentResult } from "../types";
import { Icon, VerdictChip, VerdictInfo, when } from "./bits";
import { useLoaded } from "./hooks";
import { accuracyText } from "./RunSummary";
import { Page } from "./Shell";

const stated = (r: ParentResult) => `${r.items.filter((i) => i.status === "covered").length} of ${r.items.length} parts stated`;

export function Compare() {
  const { runId = "", otherId = "" } = useParams();
  const navigate = useNavigate();
  const a = useRuns((s) => s.runs[runId]);
  const b = useRuns((s) => s.runs[otherId]);
  const loaded = useRuns((s) => s.loaded);
  const questionnaire = useLoaded(a?.kind === "questionnaire" ? a.sourceId : undefined, () => loadQuestionnaire(a!.sourceId)).value;
  if (!loaded) return null;
  if (!a || !b || a.sourceId !== b.sourceId || a.kind !== "questionnaire" || b.kind !== "questionnaire")
    return (
      <Page>
        <p>These two runs cannot be compared.</p>
        <Link to="/" className="font-semibold text-stamp">
          Back to the start
        </Link>
      </Page>
    );

  const d = differences(a.results, b.results);
  const text = new Map(questionnaire?.questions.map((q) => [String(q.number), q.text]));
  const heading = (run: Run) => (
    <span>
      <span className="block font-semibold text-ink">{accuracyText(run)}</span>
      <span className="font-normal">{when(run.createdAt)}</span>
    </span>
  );
  const cell = (run: Run, r: ParentResult) => (
    <button type="button" onClick={() => navigate(`/run/${run.id}/q/${r.parentId}`)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-desk" title="Open this answer">
      <VerdictChip verdict={r.verdict} size="sm" />
      <span className="mt-1 block text-[12.5px] text-ink-soft">{stated(r)}</span>
      <span className="block text-[12.5px] text-ink-soft">{r.suggestedCitation}</span>
    </button>
  );

  return (
    <Page wide>
      <Link to={`/run/${a.id}`} className="inline-flex items-center gap-1 text-[14px] font-semibold text-stamp">
        <Icon name="left" />
        All answers
      </Link>
      <h1 className="mt-3 font-serif text-[26px] font-semibold leading-tight">Where two runs disagree</h1>
      <p className="mt-1 text-[14px] text-ink-soft">
        {a.title}. {d.changed.length === 0 ? "Both runs gave" : `${d.changed.length} of ${d.changed.length + d.same} questions got a different verdict; the other ${d.same} got`} the same verdict{d.changed.length === 0 ? ` on all ${d.same} questions they share` : ""}.
        {(d.onlyInA.length > 0 || d.onlyInB.length > 0) && ` ${d.onlyInA.length + d.onlyInB.length} questions were answered in only one of the runs and are left out.`}
      </p>

      {d.changed.length > 0 && (
        <div className="mt-5 rounded-md border border-rule bg-paper">
          <div className="grid grid-cols-[3rem_minmax(0,1fr)_15rem_15rem] items-end gap-x-4 border-b border-rule px-5 py-3 text-[13px] text-ink-soft">
            <span />
            <span className="flex items-center gap-1">
              Question <VerdictInfo />
            </span>
            {heading(a)}
            {heading(b)}
          </div>
          <ol className="divide-y divide-rule-soft">
            {d.changed.map(({ parentId, a: ra, b: rb }) => (
              <li key={parentId} className="grid grid-cols-[3rem_minmax(0,1fr)_15rem_15rem] items-start gap-x-4 px-5 py-3">
                <span className="pt-1 font-semibold tabular-nums text-ink-soft">Q{parentId}</span>
                <span className="pt-1 font-serif text-[15.5px] leading-snug">{text.get(parentId) ?? ""}</span>
                {cell(a, ra)}
                {cell(b, rb)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Page>
  );
}
