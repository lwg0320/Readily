import { Link, useNavigate } from "react-router-dom";
import { useCatalog } from "../store/catalog";
import { useRunner } from "../store/runner";
import { useRuns, type Run } from "../store/runs";
import { useSettings } from "../store/settings";
import { Button, Icon, when } from "./bits";
import { accuracyText, costText, VerdictCounts } from "./RunSummary";
import { Page } from "./Shell";

export function Home() {
  const catalog = useCatalog((s) => s.catalog);
  const runs = useRuns((s) => s.runs);
  if (!catalog) return null;
  const recent = Object.values(runs).sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Page>
      <h1 className="font-serif text-[30px] font-semibold leading-tight">Answer DHCS from your own policies</h1>
      <p className="mt-3 max-w-[40rem] text-[16px] text-ink-soft">
        Readily reads every Medi-Cal policy in the library against each DHCS question, quotes the exact text that answers it, and shows you where nothing does. You approve each answer before it reaches the form.
      </p>

      <p className="mt-6 flex items-center gap-2 text-[14px] text-ink-soft">
        <Icon name="check" className="text-covered" />
        Library ready: {catalog.counts.policies} policies, {catalog.counts.mediCalPolicies} of them Medi-Cal, {catalog.counts.pages.toLocaleString()} pages.
      </p>

      <section className="mt-8">
        <h2 className="text-[17px] font-bold">Questionnaires</h2>
        <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
          {catalog.questionnaires.map((q) => (
            <li key={q.id} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-serif text-[18px] font-semibold leading-snug">
                  APL {q.aplNumber}: {q.subject}
                </p>
                <p className="mt-0.5 text-[14px] text-ink-soft">DHCS Submission Review Form, {q.questionCount} questions. The APL itself is in the library.</p>
              </div>
              <Link to={`/questionnaire/${q.id}`} className="shrink-0 rounded bg-stamp px-4 py-2 text-[14px] font-semibold text-white hover:bg-stamp-dark">
                Answer this questionnaire
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-[17px] font-bold">Your runs</h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-[14px] text-ink-soft">Nothing yet. Answers you produce are kept in this browser and listed here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
            {recent.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

function RunRow({ run }: { run: Run }) {
  const navigate = useNavigate();
  const { active, start } = useRunner();
  const hasKey = useSettings((s) => !!s.apiKey);
  const isActive = active?.runId === run.id;
  const ready = run.results.length;
  const approved = run.results.filter((r) => r.approved).length;

  return (
    <li className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{run.title}</p>
        <p className="mt-0.5 text-[13px] text-ink-soft">
          {when(run.createdAt)}, {accuracyText(run)}, {costText(run)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {run.status === "done" ? (
            <span className="text-[13px] text-ink-soft">
              {approved} of {run.questionCount} approved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-review">
              <Icon name="clock" />
              {isActive ? "Running" : "Paused"}, {ready} of {run.questionCount} answers ready
            </span>
          )}
          <VerdictCounts run={run} />
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {run.status === "paused" && !active && hasKey && (
          <Button
            onClick={() => {
              start(run.sourceId, run.id);
              navigate(`/questionnaire/${run.sourceId}`);
            }}
          >
            Resume
          </Button>
        )}
        {isActive && <Button onClick={() => navigate(`/questionnaire/${run.sourceId}`)}>See progress</Button>}
        {ready > 0 && (
          <Button kind="primary" onClick={() => navigate(`/run/${run.id}`)}>
            {run.status === "done" ? "Open answers" : "Open answers so far"}
          </Button>
        )}
      </div>
    </li>
  );
}
