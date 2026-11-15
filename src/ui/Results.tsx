// The answers for one run, riskiest first (ARCHITECTURE.md §10.3, Step 16).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { download, runToCsv } from "../export/csv";
import { fillForm, type FormAnswer } from "../export/fillForm";
import { estimateQuestionnaire, formatCost } from "../pipeline/estimate";
import { sortByRisk } from "../pipeline/verdicts";
import { useAccuracy } from "../store/accuracy";
import { loadQuestionnaire, pdfUrl, useCatalog } from "../store/catalog";
import { useRunner } from "../store/runner";
import { currentAnswer, failedCount, outdatedPolicies, useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import type { ParentResult, Verdict } from "../types";
import { Bar, Button, Icon, VerdictChip, VerdictInfo } from "./bits";
import { useLoaded } from "./hooks";
import { rowFlags, VERDICT_LABEL, VERDICT_ORDER } from "./labels";
import { when } from "./bits";
import { accuracyText, costText, verdictCounts } from "./RunSummary";
import { Page } from "./Shell";

const excerpt = (text: string, max = 150) => (text.length <= max ? text : text.slice(0, text.lastIndexOf(" ", max)) + "…");

export function Results() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const run = useRuns((s) => s.runs[runId]);
  const loaded = useRuns((s) => s.loaded);
  const catalog = useCatalog((s) => s.catalog);
  const { active, start } = useRunner();
  const hasKey = useSettings((s) => !!s.apiKey);
  const { fullReading, secondOpinion } = useAccuracy();
  const allRuns = useRuns((s) => s.runs);
  const questionnaire = useLoaded(run?.kind === "questionnaire" ? run.sourceId : undefined, () => loadQuestionnaire(run!.sourceId)).value;

  const [filter, setFilter] = useState<Verdict | null>(null);
  const [order, setOrder] = useState<"risk" | "number">("risk");
  const [exporting, setExporting] = useState(false);
  // While a run is still producing answers, the list on screen does not move under the reader:
  // new answers wait behind a banner until she asks for them.
  const [shown, setShown] = useState<Set<string> | null>(null);
  const isActive = active?.runId === runId;
  useEffect(() => {
    if (run && shown === null) setShown(new Set(run.results.map((r) => r.parentId)));
  }, [run, shown]);

  const rows = useMemo(() => {
    if (!run) return [];
    const visible = run.results.filter((r) => !isActive || !shown || shown.has(r.parentId));
    const sorted = order === "risk" ? sortByRisk(visible) : [...visible].sort((a, b) => Number(a.parentId) - Number(b.parentId));
    return filter ? sorted.filter((r) => r.verdict === filter) : sorted;
  }, [run, shown, isActive, order, filter]);

  if (!loaded || !catalog) return null;
  if (!run)
    return (
      <Page>
        <p>This run is not saved in this browser.</p>
        <Link to="/" className="font-semibold text-stamp">
          Back to the start
        </Link>
      </Page>
    );

  // a Guide section's check is shown on the Guide page, not as a list of questions
  if (run.kind === "section") return <Navigate to={`/guide/${run.sourceId}/${run.section?.id ?? ""}`} replace />;

  const counts = verdictCounts(run);
  const waiting = isActive && shown ? run.results.filter((r) => !shown.has(r.parentId)).length : 0;
  const approved = run.results.filter((r) => r.approved).length;
  const failed = failedCount(run);
  const outdated = outdatedPolicies(run);
  const meta = catalog.questionnaires.find((q) => q.id === run.sourceId);
  const others = Object.values(allRuns)
    .filter((r) => r.id !== run.id && r.kind === "questionnaire" && r.sourceId === run.sourceId && r.results.length > 0)
    .sort((x, y) => y.createdAt - x.createdAt);
  const switched = run.models.fullReading !== fullReading || run.models.secondOpinion !== secondOpinion;
  const again = estimateQuestionnaire({ questions: run.questionCount, mediCalPolicies: catalog.counts.mediCalPolicies, models: { fullReading, secondOpinion }, reuse: run.demo ? undefined : run.models });
  const text = new Map(questionnaire?.questions.map((q) => [String(q.number), q.text]));

  const exportCsv = () => questionnaire && download(`APL-${meta?.aplNumber ?? run.sourceId}-answers.csv`, runToCsv(questionnaire.questions, run.results), "text/csv;charset=utf-8");
  const exportForm = async () => {
    if (!questionnaire?.formMap) return;
    const answers: FormAnswer[] = run.results.flatMap((r) => {
      const { answer, citation } = currentAnswer(r);
      return r.approved && answer ? [{ number: Number(r.parentId), answer, citation }] : [];
    });
    const missing = run.questionCount - answers.length;
    if (missing > 0 && !window.confirm(`${missing} of ${run.questionCount} questions are not approved yet. They will be left blank on the form. Continue?`)) return;
    setExporting(true);
    try {
      const pdf = await (await fetch(pdfUrl("questionnaires", run.sourceId))).arrayBuffer();
      download(`APL-${meta?.aplNumber ?? run.sourceId}-Submission-Review-Form-filled.pdf`, await fillForm(pdf, questionnaire.formMap, answers), "application/pdf");
    } catch (err) {
      console.error(err);
      window.alert("The form could not be filled. Download the CSV instead; it has every answer and citation.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Page wide>
      <Link to="/" className="inline-flex items-center gap-1 text-[14px] font-semibold text-stamp">
        <Icon name="left" />
        Start
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight">{run.title}</h1>
          <p className="mt-1 text-[14px] text-ink-soft">
            {run.results.length} of {run.questionCount} questions answered. Read all {run.policiesRead} Medi-Cal policies{run.checkCount ? ` against ${run.checkCount} checks` : ""}. {accuracyText(run)}, {costText(run)}.
          </p>
        </div>
        <div className="flex gap-2">
          {questionnaire?.formMap && (
            <Button kind="primary" onClick={exportForm} disabled={exporting || approved === 0} title={approved === 0 ? "Approve at least one answer first" : undefined}>
              {exporting ? "Filling the form…" : "Fill DHCS form"}
            </Button>
          )}
          <Button onClick={exportCsv} disabled={!questionnaire}>
            Download CSV
          </Button>
        </div>
      </div>

      {(isActive || run.status === "paused" || failed > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-rule bg-paper px-4 py-3 text-[14px]">
          {isActive ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" />
              <span>
                Still working: {run.results.length} of {run.questionCount} answers ready.
              </span>
              {waiting > 0 && (
                <Button onClick={() => setShown(new Set(run.results.map((r) => r.parentId)))}>
                  Show {waiting} more {waiting === 1 ? "answer" : "answers"}
                </Button>
              )}
              <Link to={`/questionnaire/${run.sourceId}`} className="font-semibold text-stamp">
                See progress
              </Link>
            </>
          ) : run.status === "paused" ? (
            <>
              <Icon name="clock" className="text-review" />
              <span>
                This run is paused with {run.results.length} of {run.questionCount} answers ready. Finished work is saved.
              </span>
              {hasKey && !active && <Button onClick={() => start(run.sourceId, run.id)}>Resume</Button>}
            </>
          ) : (
            <>
              <Icon name="alert" className="text-review" />
              <span>
                {failed} {failed === 1 ? "question has a check" : "questions have checks"} that could not be analysed.
              </span>
              {hasKey && !active && <Button onClick={() => start(run.sourceId, run.id)}>Retry these</Button>}
            </>
          )}
        </div>
      )}

      {run.demo && <p className="mt-3 rounded bg-marker-soft px-4 py-2 text-[14px]">This is a demo run that came with the site. You can open every answer, approve and export without an API key. What you approve is kept in this browser.</p>}

      {(others.length > 0 || (switched && run.status === "done")) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-rule bg-paper px-4 py-3 text-[14px]">
          {switched && run.status === "done" && (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                The switches are now set to {accuracyText({ models: { fullReading, secondOpinion } }).toLowerCase()}. Running again makes a new run and keeps this one: about {formatCost(again.cost)} and {again.minutes} minutes.
              </span>
              {hasKey ? (
                <Button
                  disabled={!!active}
                  onClick={() => {
                    start(run.sourceId);
                    navigate(`/questionnaire/${run.sourceId}`);
                  }}
                >
                  Run again at these settings
                </Button>
              ) : (
                <span className="text-ink-soft">Add an API key in Settings to run it.</span>
              )}
            </div>
          )}
          {others.length > 0 && (
            <label className="flex items-center gap-2">
              Compare with
              <select
                value=""
                onChange={(e) => e.target.value && navigate(`/run/${run.id}/compare/${e.target.value}`)}
                className="rounded border border-rule bg-paper px-2 py-1.5"
                aria-label="Show where this run and another run disagree"
              >
                <option value="">another run of this questionnaire…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {when(o.createdAt)}, {accuracyText(o)}
                    {o.demo ? ", demo" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {outdated.length > 0 && (
        <div className="mt-4 flex gap-2.5 rounded-md bg-review-wash px-4 py-3 text-[14px] text-review">
          <Icon name="clock" className="mt-0.5" />
          <div>
            <p className="font-semibold">{outdated.length === 1 ? "A policy these answers rest on may be out of date" : "Policies these answers rest on may be out of date"}</p>
            <ul className="mt-0.5">
              {outdated.slice(0, 4).map((p) => (
                <li key={p.policyId}>
                  <span className="font-semibold">{p.policyId}</span> (cited in {p.answers} {p.answers === 1 ? "answer" : "answers"}) {p.notes.join(", and ")}.
                </li>
              ))}
              {outdated.length > 4 && <li>And {outdated.length - 4} more, shown on the questions that cite them.</li>}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterButton on={filter === null} onClick={() => setFilter(null)}>
          All <span className="font-normal tabular-nums">{run.results.length}</span>
        </FilterButton>
        {VERDICT_ORDER.map((v) => (
          <FilterButton key={v} on={filter === v} onClick={() => setFilter(filter === v ? null : v)} disabled={counts[v] === 0} label={`Show only ${VERDICT_LABEL[v]}`}>
            <VerdictChip verdict={v} count={counts[v]} size="sm" />
          </FilterButton>
        ))}
        <VerdictInfo />
        <div className="ml-auto flex items-center gap-2 text-[13px] text-ink-soft">
          <label htmlFor="order">Order</label>
          <select id="order" value={order} onChange={(e) => setOrder(e.target.value as "risk" | "number")} className="rounded border border-rule bg-paper px-2 py-1 text-ink">
            <option value="risk">Riskiest first</option>
            <option value="number">Question number</option>
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[13px] text-ink-soft">
        <span className="shrink-0 tabular-nums">
          {approved} of {run.questionCount} approved
        </span>
        <div className="max-w-xs flex-1">
          <Bar done={approved} total={run.questionCount} />
        </div>
      </div>

      <ol className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
        {rows.map((r) => (
          <Row key={r.parentId} result={r} text={text.get(r.parentId) ?? ""} onOpen={() => navigate(`/run/${run.id}/q/${r.parentId}`)} />
        ))}
        {rows.length === 0 && <li className="px-5 py-8 text-center text-ink-soft">{run.results.length === 0 ? "No answers yet." : "No answers with this verdict."}</li>}
      </ol>
    </Page>
  );
}

function FilterButton({ on, onClick, disabled, label, children }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={`rounded border px-1.5 py-1 text-[13px] font-semibold disabled:opacity-40 ${on ? "border-ink bg-paper" : "border-transparent hover:border-rule"}`}
    >
      {children}
    </button>
  );
}

function Row({ result: r, text, onOpen }: { result: ParentResult; text: string; onOpen: () => void }) {
  const flags = rowFlags(r.items.flatMap((i) => i.flags.map((f) => f.code)));
  const { answer, citation } = currentAnswer(r);
  const done = r.items.filter((i) => i.status === "covered").length;
  return (
    <li>
      <button type="button" onClick={onOpen} className="grid w-full grid-cols-[3rem_minmax(0,1fr)_9.5rem_minmax(0,15rem)_6.5rem] items-start gap-x-4 px-5 py-3 text-left hover:bg-desk/60">
        <span className="pt-0.5 font-semibold tabular-nums text-ink-soft">Q{r.parentId}</span>
        <span className="min-w-0">
          <span className="font-serif text-[15.5px] leading-snug">{excerpt(text)}</span>
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-ink-soft">
            <span>
              {done} of {r.items.length} parts stated
            </span>
            {flags.slice(0, 3).map((f) => (
              <span key={f} className="text-review">
                {f}
              </span>
            ))}
            {r.followUp !== undefined && (
              <span className="inline-flex items-center gap-1 font-semibold text-stamp">
                <Icon name="flag" />
                follow-up{r.followUp ? `: ${r.followUp}` : ""}
              </span>
            )}
          </span>
        </span>
        <span>
          <VerdictChip verdict={r.verdict} size="sm" />
        </span>
        <span className="min-w-0 pt-0.5 text-[13px] text-ink-soft">{citation || (r.verdict === "not_found" ? "Nothing to cite" : "")}</span>
        <span className="pt-0.5 text-right text-[13px]">
          {r.approved ? (
            <span className="stamp text-[11.5px]">{answer === "yes" ? "Yes" : "No"}, approved</span>
          ) : answer ? (
            <span className="text-ink-soft">Suggests {answer === "yes" ? "Yes" : "No"}</span>
          ) : (
            <span className="text-ink-soft">You decide</span>
          )}
        </span>
      </button>
    </li>
  );
}
