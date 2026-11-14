// Start screen and live progress for one questionnaire (ARCHITECTURE.md §10.3).
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TASKS } from "../config/models";
import { estimateQuestionnaire, formatCost } from "../pipeline/estimate";
import { useCatalog } from "../store/catalog";
import { useRunner, type ActiveRun } from "../store/runner";
import { useRuns, type Run } from "../store/runs";
import { useSettings } from "../store/settings";
import { Bar, Button, Icon, when } from "./bits";
import { accuracyText, costText, VerdictCounts } from "./RunSummary";
import { Page } from "./Shell";

export function QuestionnaireStart() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const catalog = useCatalog((s) => s.catalog);
  const { active, problem, start, dismissProblem } = useRunner();
  const runs = useRuns((s) => s.runs);
  const { apiKey, openSettings } = useSettings();
  const meta = catalog?.questionnaires.find((q) => q.id === id);
  if (!catalog) return null;
  if (!meta)
    return (
      <Page>
        <p>This questionnaire is not in the library.</p>
        <Link to="/" className="font-semibold text-stamp">
          Back to the start
        </Link>
      </Page>
    );

  const mine = Object.values(runs)
    .filter((r) => r.sourceId === id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const models = { fullReading: TASKS.fullReading.model, secondOpinion: TASKS.secondOpinion.model };
  const estimate = estimateQuestionnaire({ questions: meta.questionCount, mediCalPolicies: catalog.counts.mediCalPolicies, models });
  const running = active?.sourceId === id ? active : null;
  const runningRun = running ? runs[running.runId] : undefined;
  const paused = mine.find((r) => r.status === "paused");
  const myProblem = problem?.sourceId === id ? problem : null;

  return (
    <Page>
      <Link to="/" className="inline-flex items-center gap-1 text-[14px] font-semibold text-stamp">
        <Icon name="left" />
        All questionnaires
      </Link>
      <h1 className="mt-3 font-serif text-[28px] font-semibold leading-tight">
        APL {meta.aplNumber}: {meta.subject}
      </h1>
      <p className="mt-2 text-ink-soft">
        DHCS Submission Review Form, {meta.questionCount} questions.{" "}
        <span className="inline-flex items-center gap-1 text-covered">
          <Icon name="check" />
          APL {meta.aplNumber} is in the library
        </span>
      </p>

      {myProblem && (
        <div className="mt-6 rounded-md border border-conflict/40 bg-conflict-wash px-5 py-4" role="alert">
          <p className="font-semibold text-conflict">{myProblem.message}</p>
          <div className="mt-3 flex gap-2">
            {(myProblem.kind === "auth" || myProblem.kind === "no_key" || myProblem.kind === "billing") && <Button onClick={() => openSettings(true)}>Open Settings</Button>}
            <Button kind="quiet" onClick={dismissProblem}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {running ? (
        <Progress active={running} run={runningRun} policies={catalog.counts.mediCalPolicies} />
      ) : (
        <section className="mt-7 rounded-md border border-rule bg-paper px-6 py-5">
          <h2 className="text-[17px] font-bold">What a run does</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] marker:font-semibold marker:text-ink-faint">
            <li>Splits each question into the separate things DHCS is asking for.</li>
            <li>Reads all {catalog.counts.mediCalPolicies} Medi-Cal policies against every one of them.</li>
            <li>Reads the policies that matter in full and quotes the exact text.</li>
            <li>Checks every quote against the source, and gets a second opinion on every answer.</li>
          </ol>
          <p className="mt-4 text-[14px] text-ink-soft">Runs at {accuracyText({ models }).toLowerCase()}.</p>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule-soft pt-5">
            {apiKey ? (
              paused ? (
                <>
                  <Button kind="primary" onClick={() => start(id, paused.id)}>
                    Resume the paused run
                  </Button>
                  <span className="text-[14px] text-ink-soft">
                    {paused.results.length} of {paused.questionCount} answers are ready. Finished work is saved, so resuming only pays for what is left.
                  </span>
                </>
              ) : (
                <>
                  <Button kind="primary" onClick={() => start(id)}>
                    Run all {meta.questionCount} questions
                  </Button>
                  <span className="text-[14px] text-ink-soft">
                    {mine.length > 0
                      ? `Work already finished in this browser is reused at no cost. From scratch, a run is about ${formatCost(estimate.cost)} and ${estimate.minutes} minutes.`
                      : `About ${formatCost(estimate.cost)} and ${estimate.minutes} minutes. You can start reviewing as soon as the first answers arrive.`}
                  </span>
                </>
              )
            ) : (
              <>
                <Button kind="primary" onClick={() => openSettings(true)}>
                  Add your API key to run live
                </Button>
                <span className="text-[14px] text-ink-soft">
                  A full run costs about {formatCost(estimate.cost)} on your Anthropic account. Saved answers can be opened without a key.
                </span>
              </>
            )}
          </div>
        </section>
      )}

      {mine.filter((r) => r.id !== running?.runId).length > 0 && (
        <section className="mt-8">
          <h2 className="text-[17px] font-bold">Earlier runs of this questionnaire</h2>
          <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
            {mine
              .filter((r) => r.id !== running?.runId)
              .map((run) => (
                <PastRun key={run.id} run={run} onOpen={() => navigate(`/run/${run.id}`)} />
              ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

function PastRun({ run, onOpen }: { run: Run; onOpen: () => void }) {
  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[14px]">
          <span className="font-semibold">{when(run.createdAt)}</span>
          <span className="text-ink-soft">
            , {accuracyText(run)}, {costText(run)}
            {run.status === "paused" && `, paused with ${run.results.length} of ${run.questionCount} answers ready`}
          </span>
        </p>
        <div className="mt-1.5">
          <VerdictCounts run={run} />
        </div>
      </div>
      {run.results.length > 0 && <Button onClick={onOpen}>{run.status === "done" ? "Open answers" : "Open answers so far"}</Button>}
    </li>
  );
}

function Step({ state, children, detail }: { state: "done" | "now" | "later"; children: ReactNode; detail?: ReactNode }) {
  return (
    <li className="flex gap-3 py-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        {state === "done" ? (
          <Icon name="check" className="text-covered" />
        ) : state === "now" ? (
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-rule" />
        )}
      </span>
      <div className={`min-w-0 flex-1 ${state === "later" ? "text-ink-faint" : ""}`}>
        <p className={state === "now" ? "font-semibold" : ""}>{children}</p>
        {detail}
      </div>
    </li>
  );
}

function Progress({ active, run, policies }: { active: ActiveRun; run: Run | undefined; policies: number }) {
  const navigate = useNavigate();
  const cancel = useRunner((s) => s.cancel);
  const ready = run?.results.length ?? 0;
  const total = run?.questionCount ?? active.checklist.total;
  const order = ["library", "checklist", "screening", "reading"] as const;
  const at = order.indexOf(active.stage);
  const state = (i: number) => (i < at ? "done" : i === at ? "now" : "later") as "done" | "now" | "later";
  const count = (c: { done: number; total: number }) => (c.total ? `${c.done.toLocaleString()} of ${c.total.toLocaleString()}` : "");

  return (
    <section className="mt-7 rounded-md border border-rule bg-paper px-6 py-5" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[17px] font-bold">Working through the questionnaire</h2>
        <p className="text-[14px] text-ink-soft tabular-nums">{run && run.cost > 0 ? `${formatCost(run.cost)} so far` : ""}</p>
      </div>

      <ul className="mt-2 divide-y divide-rule-soft">
        {active.stage === "library" && (
          <Step state="now" detail={<div className="mt-2 max-w-sm"><Bar done={active.library.done} total={active.library.total} /></div>}>
            Loading {policies} Medi-Cal policies {count(active.library) && `(${count(active.library)})`}
          </Step>
        )}
        <Step state={state(1)} detail={state(1) === "now" ? <div className="mt-2 max-w-sm"><Bar done={active.checklist.done} total={active.checklist.total} /></div> : undefined}>
          {state(1) === "done" && active.checks !== null
            ? `Split ${active.checklist.total} questions into ${active.checks} separate checks`
            : `Splitting each question into separate checks ${state(1) === "now" && count(active.checklist) ? `(${count(active.checklist)})` : ""}`}
        </Step>
        <Step state={state(2)} detail={state(2) === "now" ? <div className="mt-2 max-w-sm"><Bar done={active.screening.done} total={active.screening.total} /></div> : undefined}>
          {state(2) === "done" ? `Read all ${policies} Medi-Cal policies against every check` : `Reading all ${policies} Medi-Cal policies against every check ${state(2) === "now" && count(active.screening) ? `(${count(active.screening)} reads)` : ""}`}
        </Step>
        <Step state={state(3)} detail={state(3) === "now" ? <div className="mt-2 max-w-sm"><Bar done={ready} total={total} /></div> : undefined}>
          Reading the policies that matter in full, checking every quote, and getting a second opinion {state(3) === "now" ? `(${ready} of ${total} answers ready)` : ""}
        </Step>
      </ul>

      {active.slow && <p className="mt-3 rounded bg-review-wash px-3 py-2 text-[14px] text-review">The API is limiting our speed. Still working; nothing is lost.</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule-soft pt-4">
        {ready > 0 && run && (
          <Button kind="primary" onClick={() => navigate(`/run/${run.id}`)}>
            Start reviewing: {ready} {ready === 1 ? "answer" : "answers"} ready
          </Button>
        )}
        <Button onClick={cancel}>Pause this run</Button>
        <span className="text-[13px] text-ink-soft">Pausing keeps everything finished so far. Keep this tab open while it runs.</span>
      </div>
    </section>
  );
}
